import { describe, expect, it } from "bun:test";
import type { Transport } from "viem";
import { withNullBlockRetry } from "./nullBlockRetry";

function transportReturning(
  results: unknown[],
): { transport: Transport; calls: { method: string }[] } {
  const calls: { method: string }[] = [];
  let index = 0;

  const transport = ((): unknown => ({
    config: {},
    value: {},
    request: async (args: { method: string }) => {
      calls.push({ method: args.method });
      return index < results.length ? results[index++] : results.at(-1);
    },
  })) as Transport;

  return { transport, calls };
}

const options = {} as never;
const getBlock = { method: "eth_getBlockByNumber", params: ["0x1", false] };

describe("withNullBlockRetry", () => {
  it("retries a null block on the same transport and returns the block", async () => {
    const { transport, calls } = transportReturning([null, null, { number: "0x1" }]);

    const wrapped = withNullBlockRetry(transport, { retryDelayMs: 0 })(options);

    expect(await wrapped.request(getBlock)).toEqual({ number: "0x1" });
    expect(calls).toHaveLength(3);
  });

  it("throws after exhausting retries so a fallback transport is tried", async () => {
    const { transport, calls } = transportReturning([null]);

    const wrapped = withNullBlockRetry(transport, {
      retryCount: 2,
      retryDelayMs: 0,
      url: "https://a.rpc",
    })(options);

    await expect(wrapped.request(getBlock)).rejects.toThrow(
      /returned a null block after 2 retries on https:\/\/a\.rpc/,
    );
    expect(calls).toHaveLength(3);
  });

  it("passes other methods through without retrying", async () => {
    const { transport, calls } = transportReturning([null]);

    const wrapped = withNullBlockRetry(transport, { retryDelayMs: 0 })(options);

    expect(await wrapped.request({ method: "eth_blockNumber" })).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
