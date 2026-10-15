import type { Transport } from "viem";

const RETRIED_METHODS = new Set(["eth_getBlockByHash", "eth_getBlockByNumber"]);

const DEFAULT_RETRY_COUNT = 5;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<rpc url>";
  }
}
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
            throw new Error(
              `${args.method} returned a null block after ${retryCount} retries${
                url ? ` on ${originOf(url)}` : ""
              }: ${JSON.stringify(args.params)}`,
            );
          }

          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      },
    };
  }) as Transport;
}
