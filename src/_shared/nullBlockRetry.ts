import type { Transport } from "viem";

// Block lookups can return a null result when an RPC node is briefly behind the
// head it just advertised. That is a successful JSON-RPC response, so neither
// viem's transport retries nor the stream's own retry helper cover it: the
// caller simply sees a null block and throws, which exits the process.
//
// Retrying the same transport gives a lagging node time to catch up, which
// keeps these lookups on the primary RPC instead of failing over to a more
// expensive one on every transient miss.
const RETRIED_METHODS = new Set(["eth_getBlockByHash", "eth_getBlockByNumber"]);

const DEFAULT_RETRY_COUNT = 5;
const DEFAULT_RETRY_DELAY_MS = 600;

export function withNullBlockRetry(
  transport: Transport,
  {
    retryCount = DEFAULT_RETRY_COUNT,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    url,
  }: { retryCount?: number; retryDelayMs?: number; url?: string } = {},
): Transport {
  return ((options) => {
    const inner = transport(options);

    return {
      ...inner,
      async request(args: { method: string; params?: unknown }) {
        if (!RETRIED_METHODS.has(args.method)) {
          return inner.request(args as never);
        }

        for (let attempt = 0; ; attempt++) {
          const result = await inner.request(args as never);

          if (result !== null) {
            return result;
          }

          if (attempt >= retryCount) {
            // Throw rather than returning null so that a fallback transport
            // treats this as a failure and tries the next RPC.
            throw new Error(
              `${args.method} returned a null block after ${retryCount} retries${
                url ? ` on ${url}` : ""
              }: ${JSON.stringify(args.params)}`,
            );
          }

          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      },
    };
  }) as Transport;
}
