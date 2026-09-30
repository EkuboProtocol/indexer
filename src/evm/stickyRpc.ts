/**
 * An ordered list of EVM RPC endpoints, read one at a time (EKU-502).
 *
 * viem's `fallback()` picks a transport per request, so one range read could be
 * fenced by a head from one provider and filled with logs from another -- the
 * A -> B -> A case the README's endpoint consistency contract says the hash
 * fence cannot catch. Here every request goes to the *current* endpoint, and
 * the current endpoint changes only in `beforeTick`, which the block stream
 * calls at the top of a loop turn and nowhere else.
 *
 * It leaves the current endpoint when the last read failed, or when its head
 * has fallen more than `staleHeadMs` behind the wall clock -- the second is
 * the Unichain freeze of 2026-09-30, which produced no error at all. It goes
 * back to the first endpoint after `failbackMs`, so a paid fallback does not
 * quietly become the primary.
 *
 * Every switch is probed first, in both directions. A candidate must answer
 * with the right chain ID, a `latest` block at or above the cursor, and a head
 * that is fresh; leaving a stale head also needs the candidate to be ahead of
 * it. Without the probe a real chain halt -- every provider stale at once --
 * would flip endpoints every turn for the whole halt, and a failback to a
 * primary still frozen below the cursor would stall the stream on unreadable
 * cursor headers. A candidate that fails is not probed again for
 * `probeIntervalMs`.
 *
 * An endpoint's chain ID is verified before its first use. A wrong chain ID is
 * fatal wherever it is found; an endpoint that does not answer is only skipped,
 * so a secondary's outage can never stop a worker whose primary is healthy.
 */
import { hexToNumber, type Hex } from "viem";
import type { ChainHead, EndpointSelector, TickSignal } from "../_shared/blockStream";
import type { RpcLike } from "./logStream";

export interface StickyEndpoint {
  /** Safe to log: the origin only, never the path or query that hold a key. */
  label: string;
  rpc: RpcLike;
  /** This endpoint's `eth_getLogs` result cap; see SUSPECT_LOG_COUNT. */
  suspectLogCount: number;
}

export interface StickyRpcOptions {
  chainId: bigint;
  staleHeadMs: number;
  failbackMs: number;
  probeIntervalMs: number;
  onWarning?: (message: string, detail: Record<string, unknown>) => void;
  now?: () => number;
}

export class WrongChainIdError extends Error {
  override readonly name = "WrongChainIdError";
}

export class StickyRpc implements RpcLike, EndpointSelector {
  private index = 0;
  private switchedAt: number;
  private readonly verified: boolean[];
  private readonly nextProbe: number[];
  private readonly now: () => number;

  constructor(
    private readonly endpoints: StickyEndpoint[],
    private readonly opts: StickyRpcOptions,
  ) {
    if (endpoints.length === 0) throw new Error("StickyRpc needs at least one endpoint");
    this.now = opts.now ?? Date.now;
    this.switchedAt = this.now();
    this.verified = endpoints.map(() => false);
    this.nextProbe = endpoints.map(() => 0);
  }

  get current(): StickyEndpoint {
    return this.endpoints[this.index]!;
  }

  request: RpcLike["request"] = ((args: never) =>
    this.current.rpc.request(args)) as RpcLike["request"];

  /**
   * Picks the first endpoint that verifies its chain ID. Throws the last error
   * when none answers, for the caller to back off and retry; throws
   * `WrongChainIdError` at once when any endpoint names another chain.
   */
  async start(): Promise<void> {
    let lastError: unknown = new Error("no RPC endpoint answered");
    for (let i = 0; i < this.endpoints.length; i++) {
      try {
        await this.verify(i);
        this.select(i, "startup");
        return;
      } catch (error) {
        if (error instanceof WrongChainIdError) throw error;
        lastError = error;
        this.opts.onWarning?.("RPC endpoint did not answer at startup; trying the next", {
          endpoint: this.endpoints[i]!.label,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
      }
    }
    throw lastError;
  }

  /**
   * `start`, retried with a doubling delay until an endpoint verifies or
   * `budgetMs` has passed. A wrong chain ID is still fatal at once.
   *
   * Throwing on the first unanswered startup is what kept a total outage a
   * restart loop even after the stream learnt to back off: `restart.sh`
   * restarts at once, and every restart asks the same endpoints again.
   */
  async startWithin(budgetMs: number, minDelayMs: number, maxDelayMs: number): Promise<void> {
    const since = this.now();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.start();
      } catch (error) {
        if (error instanceof WrongChainIdError || this.now() - since > budgetMs) throw error;
        const delay = Math.min(maxDelayMs, minDelayMs * 2 ** Math.min(attempt, 32));
        this.opts.onWarning?.("no RPC endpoint answered at startup; backing off", {
          attempt: attempt + 1, retryInMs: delay,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async beforeTick(signal: TickSignal): Promise<boolean> {
    if (this.endpoints.length < 2) return false;
    if (await this.failbackDue(signal)) return this.select(0, "failback");

    const reason = this.leaveReason(signal);
    if (reason === null) return false;
    // Leaving a stale head needs a candidate that is ahead of it. Leaving a
    // failed read only needs one that answers from at or above the cursor.
    const mustPass = reason === "stale head" ? signal.lastHead!.number : null;
    for (let i = 0; i < this.endpoints.length; i++) {
      if (i !== this.index && (await this.probe(i, signal, mustPass))) return this.select(i, reason);
    }
    return false;
  }

  /** Off the primary for `failbackMs`, and the primary passes its probe. */
  private async failbackDue(signal: TickSignal): Promise<boolean> {
    if (this.index === 0 || this.now() - this.switchedAt < this.opts.failbackMs) return false;
    return this.probe(0, signal, null);
  }

  private leaveReason(signal: TickSignal): "read failed" | "stale head" | null {
    if (signal.lastReadFailed) return "read failed";
    const head = signal.lastHead;
    if (head && this.now() - head.timestamp.getTime() > this.opts.staleHeadMs) return "stale head";
    return null;
  }

  private select(i: number, reason: string): boolean {
    const from = this.current.label;
    const changed = i !== this.index;
    this.index = i;
    this.switchedAt = this.now();
    if (changed) {
      this.opts.onWarning?.("switched RPC endpoint", { from, to: this.current.label, reason });
    }
    return changed;
  }

  private async verify(i: number): Promise<void> {
    if (this.verified[i]) return;
    const endpoint = this.endpoints[i]!;
    const id = BigInt(
      (await endpoint.rpc.request({ method: "eth_chainId" } as never)) as unknown as string,
    );
    if (id !== this.opts.chainId) {
      throw new WrongChainIdError(
        `RPC endpoint ${endpoint.label} returned chain ID ${id}, expected ${this.opts.chainId}`,
      );
    }
    this.verified[i] = true;
  }

  /** True when endpoint `i` can take over; a wrong chain ID still throws. */
  private async probe(i: number, signal: TickSignal, mustPass: number | null): Promise<boolean> {
    const now = this.now();
    if (now < this.nextProbe[i]!) return false;
    const endpoint = this.endpoints[i]!;
    const reject = (reason: string, detail: Record<string, unknown> = {}) => {
      this.nextProbe[i] = now + this.opts.probeIntervalMs;
      this.opts.onWarning?.("RPC endpoint not healthier; staying", {
        candidate: endpoint.label, current: this.current.label, reason, ...detail,
      });
      return false;
    };

    let head: ChainHead | null;
    try {
      await this.verify(i);
      head = await latest(endpoint.rpc);
    } catch (error) {
      if (error instanceof WrongChainIdError) throw error;
      return reject("did not answer", {
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    }
    if (!head) return reject("no latest block");
    if (head.number < signal.cursorBlock) {
      return reject("behind the cursor", { head: head.number, cursor: signal.cursorBlock });
    }
    if (now - head.timestamp.getTime() > this.opts.staleHeadMs) {
      return reject("stale head", { head: head.number, headTime: head.timestamp.toISOString() });
    }
    if (mustPass !== null && head.number <= mustPass) {
      return reject("not ahead of the current head", { head: head.number, current: mustPass });
    }
    return true;
  }
}

async function latest(rpc: RpcLike): Promise<ChainHead | null> {
  const block = (await rpc.request({
    method: "eth_getBlockByNumber",
    params: ["latest", false],
  } as never)) as unknown as { number: Hex | null; hash: Hex | null; timestamp: Hex } | null;
  if (!block || block.number === null || block.hash === null) return null;
  return {
    number: hexToNumber(block.number),
    hash: block.hash,
    timestamp: new Date(hexToNumber(block.timestamp) * 1000),
    baseFeePerGas: null,
  };
}
