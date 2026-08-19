import { metrics } from "@opentelemetry/api";
import { RateLimit, Sema } from "async-sema";
import { StarknetRpcError } from "./errors";
import { retry } from "./retry";
import type { JsonRpcResponse } from "./rpc-types";

export type StarknetRpcClientOptions = {
  requestsPerSecond?: number;
  maxConcurrency?: number;
  /** Request timeout in milliseconds. */
  timeout?: number;
  /** Number of retries after the initial request. */
  retryCount?: number;
  /** Fixed delay between retries in milliseconds. */
  retryDelay?: number;
  batch?: boolean;
  fetch?: typeof globalThis.fetch;
  /** Additional HTTP headers, for example provider authentication headers. */
  headers?: HeadersInit;
};

const meter = metrics.getMeter("@apibara/starknet-rpc");
const callCounter = meter.createCounter("apibara.starknet_rpc.calls");
const byteCounter = meter.createCounter("apibara.starknet_rpc.bytes");
const retryCounter = meter.createCounter("apibara.starknet_rpc.retries");
const throttleCounter = meter.createCounter("apibara.starknet_rpc.throttling");
const latency = meter.createHistogram("apibara.starknet_rpc.latency", {
  unit: "ms",
});

export class StarknetJsonRpcClient {
  readonly batchEnabled: boolean;
  private readonly rateLimit: () => Promise<void>;
  private readonly semaphore: Sema;
  private readonly timeout: number;
  private readonly retryCount: number;
  private readonly retryDelay: number;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly headers: Headers;
  private nextId = 1;

  constructor(
    readonly url: string,
    {
      requestsPerSecond = 10,
      maxConcurrency = 8,
      timeout = 10_000,
      retryCount = 3,
      retryDelay = 150,
      batch = false,
      fetch: fetchImplementation = globalThis.fetch,
      headers,
    }: StarknetRpcClientOptions = {},
  ) {
    if (!URL.canParse(url)) {
      throw new Error("Invalid Starknet RPC URL");
    }
    if (
      requestsPerSecond <= 0 ||
      maxConcurrency <= 0 ||
      timeout <= 0 ||
      retryCount < 0 ||
      retryDelay < 0
    ) {
      throw new Error(
        "requestsPerSecond, maxConcurrency, and timeout must be greater than zero; retryCount and retryDelay cannot be negative",
      );
    }
    this.rateLimit = RateLimit(requestsPerSecond);
    this.semaphore = new Sema(maxConcurrency);
    this.timeout = timeout;
    this.retryCount = retryCount;
    this.retryDelay = retryDelay;
    this.batchEnabled = batch;
    this.fetchImplementation = fetchImplementation;
    this.headers = new Headers(headers);
    if (!this.headers.has("content-type")) {
      this.headers.set("content-type", "application/json");
    }
  }

  async request<T>(
    method: string,
    params: readonly unknown[] | Record<string, unknown> = [],
    timeout = this.timeout,
  ): Promise<T> {
    return this.withRetry(method, () =>
      this.requestOnce<T>(method, params, timeout),
    );
  }

  async batch<T extends readonly unknown[]>(
    calls: {
      method: string;
      params?: readonly unknown[] | Record<string, unknown>;
    }[],
  ): Promise<T> {
    if (!this.batchEnabled) {
      throw new Error(
        "JSON-RPC batching is disabled. Enable it only after a successful capability probe.",
      );
    }
    if (calls.length === 0) return [] as unknown as T;

    return this.withRetry("batch", () => this.executeBatch<T>(calls));
  }

  private withRetry<T>(method: string, fn: () => Promise<T>): Promise<T> {
    return retry(fn, {
      retryCount: this.retryCount,
      retryDelay: (error) =>
        error instanceof StarknetRpcError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : this.retryDelay,
      shouldRetry: isRetryable,
      onRetry: () => retryCounter.add(1, { method }),
    });
  }

  private async executeBatch<T extends readonly unknown[]>(
    calls: {
      method: string;
      params?: readonly unknown[] | Record<string, unknown>;
    }[],
  ): Promise<T> {
    const ids = calls.map(() => this.nextId++);
    const body = calls.map((call, index) => ({
      jsonrpc: "2.0",
      id: ids[index],
      method: call.method,
      params: call.params ?? [],
    }));
    const responses = await this.fetchJson<JsonRpcResponse<unknown>[]>(
      body,
      "batch",
    );
    const byId = new Map(responses.map((response) => [response.id, response]));
    return calls.map((call, index) => {
      const response = byId.get(ids[index]);
      if (!response) {
        throw new StarknetRpcError(
          `Missing JSON-RPC batch response for ${call.method}`,
        );
      }
      if (response.error) {
        throw new StarknetRpcError(
          `${call.method}: ${response.error.message}`,
          response.error.code,
        );
      }
      return response.result;
    }) as unknown as T;
  }

  private async requestOnce<T>(
    method: string,
    params: readonly unknown[] | Record<string, unknown>,
    timeout: number,
  ): Promise<T> {
    const response = await this.fetchJson<JsonRpcResponse<T>>(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params,
      },
      method,
      timeout,
    );
    if (response.error) {
      throw new StarknetRpcError(
        `${method}: ${response.error.message}`,
        response.error.code,
      );
    }
    if (!("result" in response)) {
      throw new StarknetRpcError(`${method}: response has no result`);
    }
    return response.result as T;
  }

  private async fetchJson<T>(
    body: unknown,
    method: string,
    timeout = this.timeout,
  ): Promise<T> {
    await this.rateLimit();
    if (this.semaphore.tryAcquire() === undefined) {
      throttleCounter.add(1, { reason: "concurrency" });
      await this.semaphore.acquire();
    }
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeout);
    const startedAt = performance.now();
    const encodedBody = JSON.stringify(body);
    callCounter.add(1, { method });
    byteCounter.add(new TextEncoder().encode(encodedBody).byteLength, {
      direction: "request",
      method,
    });

    try {
      return await this.executeFetch<T>(
        encodedBody,
        method,
        timeout,
        controller.signal,
      );
    } finally {
      clearTimeout(timeoutHandle);
      this.semaphore.release();
      latency.record(performance.now() - startedAt, { method });
    }
  }

  private async executeFetch<T>(
    body: string,
    method: string,
    timeout: number,
    signal: AbortSignal,
  ): Promise<T> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImplementation(this.url, {
        method: "POST",
        headers: this.headers,
        body,
        signal,
      });
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new StarknetRpcError(
          `Starknet RPC request timed out after ${timeout}ms`,
        );
      }
      throw error;
    }

    byteCounter.add(new TextEncoder().encode(text).byteLength, {
      direction: "response",
      method,
    });
    if (!response.ok) {
      throw new StarknetRpcError(
        `Starknet RPC HTTP ${response.status}`,
        undefined,
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new StarknetRpcError("Starknet RPC returned invalid JSON");
    }
  }
}

/**
 * Retries only failures that are likely to be transient for the read-only
 * stream and capability-probe requests issued by this package.
 *
 * Invalid requests, unsupported methods, bad parameters, authentication
 * failures, and other client-side errors are deliberately excluded because a
 * retry cannot change their outcome. Revisit this policy before using it for
 * non-idempotent RPC methods: a transport failure does not prove that a write
 * was not accepted by the node.
 */
function isRetryable(error: unknown): boolean {
  // At this boundary, fetch reports network failures as TypeError. Unknown
  // exceptions are not retried because they are more likely programming or
  // caller errors than temporary node failures.
  if (!(error instanceof StarknetRpcError)) {
    return error instanceof TypeError;
  }

  // Rate limiting and server-side HTTP failures are normally temporary. Other
  // 4xx statuses are treated as request, authentication, or configuration
  // errors and surface immediately.
  if (
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return true;
  }
  // Accept the standard JSON-RPC internal error and provider-specific codes
  // commonly used for rate limiting or timeouts. Protocol/client errors such
  // as parse error, invalid request, method not found, and invalid params are
  // intentionally not included.
  if (error.code === -32603 || error.code === -32005 || error.code === -32010) {
    return true;
  }

  const message = error.message.toLowerCase();
  return (
    // This also recognizes the client's own request-timeout error. -32000 is
    // provider-defined, so retry it only when its message explicitly describes
    // a temporary load, rate-limit, or timeout condition; arbitrary -32000
    // application errors must surface without retrying.
    message.includes("timed out") ||
    (error.code === -32000 &&
      ["timeout", "busy", "temporarily", "rate limit"].some((pattern) =>
        message.includes(pattern),
      ))
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}
