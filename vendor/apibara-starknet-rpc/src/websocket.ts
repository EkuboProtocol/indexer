import { sleep } from "@apibara/protocol/rpc";

type SignalKind = "accepted" | "pending";

type SubscriptionRequest = {
  kind: SignalKind;
  resolve: (subscription: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/**
 * A small notification gate. HTTP remains the source of truth; WebSocket
 * notifications only wake the stream so provider-specific payload differences
 * cannot corrupt canonical tracking.
 */
export class StarknetWebSocketSignal {
  private socket?: WebSocket;
  private readonly pendingSignals = { accepted: false, pending: false };
  private readonly waiters = {
    accepted: new Set<() => void>(),
    pending: new Set<() => void>(),
  };
  private readonly subscriptions = new Map<string, SignalKind>();
  private readonly requests = new Map<number, SubscriptionRequest>();
  private nextId = 1;
  private pendingRequired = false;

  constructor(
    private readonly url: string,
    private readonly timeout: number,
  ) {}

  async connect(pending = true): Promise<void> {
    this.pendingRequired ||= pending;
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (
        this.pendingRequired &&
        ![...this.subscriptions.values()].includes("pending")
      ) {
        await this.subscribePending();
      }
      return;
    }
    const socket = new WebSocket(this.url);
    this.socket = socket;

    try {
      await this.waitForOpen(socket);
      socket.addEventListener("message", this.onMessage);
      socket.addEventListener("close", this.onClose, { once: true });
      await this.subscribe("starknet_subscribeNewHeads", "accepted", {});
      if (this.pendingRequired) {
        await this.subscribePending();
      }
    } catch (error) {
      this.closeSocket(socket);
      throw error;
    }
  }

  async wait(kind: SignalKind, timeoutMs: number): Promise<void> {
    if (this.pendingSignals[kind]) {
      this.pendingSignals[kind] = false;
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      try {
        await this.connect(kind === "pending");
      } catch {
        await sleep(timeoutMs);
        return;
      }
    }
    if (this.pendingSignals[kind]) {
      this.pendingSignals[kind] = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        this.waiters[kind].delete(done);
        resolve();
      };
      const timeout = setTimeout(done, timeoutMs);
      this.waiters[kind].add(done);
    });
  }

  close(): void {
    const socket = this.socket;
    if (socket) this.closeSocket(socket);
    this.pendingSignals.accepted = false;
    this.pendingSignals.pending = false;
    for (const kind of ["accepted", "pending"] as const) {
      for (const resolve of this.waiters[kind]) resolve();
      this.waiters[kind].clear();
    }
  }

  private waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () =>
        fail(new Error("Starknet WebSocket connection failed"));
      const timeout = setTimeout(
        () => fail(new Error("Starknet WebSocket connection timed out")),
        this.timeout,
      );
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
  }

  private subscribe(
    method: string,
    kind: SignalKind,
    params: Record<string, unknown>,
  ): Promise<string> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Starknet WebSocket is not connected"));
    }
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requests.delete(id);
        reject(
          new Error(`Starknet WebSocket ${method} acknowledgement timed out`),
        );
      }, this.timeout);
      this.requests.set(id, {
        kind,
        timeout,
        resolve,
        reject,
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private async subscribePending(): Promise<void> {
    // Pending streams must subscribe explicitly to PRE_CONFIRMED data. At
    // least one pending notification method is enough to wake HTTP polling.
    await Promise.any([
      this.subscribe("starknet_subscribeNewTransactions", "pending", {
        finality_status: ["PRE_CONFIRMED"],
      }),
      this.subscribe("starknet_subscribeEvents", "pending", {
        finality_status: "PRE_CONFIRMED",
      }),
    ]);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: unknown };
      params?: { subscription?: unknown; subscription_id?: unknown };
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const request = this.requests.get(message.id);
      if (!request) return;
      clearTimeout(request.timeout);
      this.requests.delete(message.id);
      if (message.error !== undefined || message.result === undefined) {
        request.reject(
          new Error(
            `Starknet WebSocket subscription rejected: ${String(message.error?.message ?? "missing result")}`,
          ),
        );
        return;
      }
      const subscription = String(message.result);
      this.subscriptions.set(subscription, request.kind);
      request.resolve(subscription);
      return;
    }
    // v0.10 notifications use `subscription_id`; keep accepting
    // `subscription` for older/provider-specific payloads.
    const subscription =
      message.params?.subscription_id ?? message.params?.subscription;
    const kind =
      subscription === undefined
        ? undefined
        : this.subscriptions.get(String(subscription));
    if (kind) this.notify(kind);
  };

  private readonly onClose = (): void => {
    this.socket = undefined;
    this.rejectRequests(new Error("Starknet WebSocket closed"));
    this.subscriptions.clear();
    this.notify("accepted");
    this.notify("pending");
  };

  private closeSocket(socket: WebSocket): void {
    socket.removeEventListener("message", this.onMessage);
    socket.removeEventListener("close", this.onClose);
    if (this.socket === socket) this.socket = undefined;
    this.rejectRequests(new Error("Starknet WebSocket closed"));
    this.subscriptions.clear();
    socket.close();
  }

  private rejectRequests(error: Error): void {
    for (const request of this.requests.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.requests.clear();
  }

  private notify(kind: SignalKind): void {
    if (this.waiters[kind].size === 0) {
      this.pendingSignals[kind] = true;
    } else {
      for (const resolve of this.waiters[kind]) resolve();
      this.waiters[kind].clear();
    }
    // An accepted head also replaces the current pre-confirmed snapshot.
    if (kind === "accepted") {
      if (this.waiters.pending.size === 0) {
        this.pendingSignals.pending = true;
      } else {
        for (const resolve of this.waiters.pending) resolve();
        this.waiters.pending.clear();
      }
    }
  }
}
