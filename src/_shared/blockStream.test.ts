import { describe, expect, it } from "bun:test";
import { StaleSnapshotError } from "./blockSnapshot";
import {
  createBlockStream,
  MAX_STALE_SNAPSHOTS,
  type ChainAdapter,
  type ChainHead,
  type StreamBlock,
  type StreamMessage,
} from "./blockStream";

const head = (number: number, hash = `0x${number.toString(16)}`): ChainHead => ({
  number,
  hash: hash as `0x${string}`,
  timestamp: new Date(number * 1000),
  baseFeePerGas: null,
});

const block = (number: number, hash: string): StreamBlock<string> => ({
  header: {
    blockNumber: BigInt(number),
    blockHash: hash as `0x${string}`,
    timestamp: new Date(number * 1000),
    baseFeePerGas: null,
  },
  logs: [hash],
});

const options = {
  pollIntervalMs: 1,
  maxPollIntervalMs: 1,
  finalizedRefreshIntervalMs: 1,
  maxLogRangeBlocks: 100,
  heartbeatIntervalMs: 1_000_000,
};

it("reconciles a reorg before accepting finality and preserves pending finality through rollback", async () => {
  let tick = 0;
  const ranges: number[][] = [];
  const end = new Error("end fixture");
  const adapter: ChainAdapter<string> = {
    label: "fixture",
    async fetchBlock(n) {
      if (n === 90) return head(90);
      if (n === 100) return head(n, tick <= 1 ? "0xaaa" : "0xbbb");
      return head(n, tick <= 1 ? "0xa101" : `0xb${n}`);
    },
    async fetchHead() {
      if (++tick > 4) throw end;
      return head(100 + tick, tick === 1 ? "0xa101" : `0xb${100 + tick}`);
    },
    async fetchFinalized() {
      if (tick === 0) return head(90);
      // The refresh after rollback may fail; the earlier observation survives.
      if (tick > 1) throw new Error("temporary finality outage");
      return head(101, "0xb101");
    },
    async readRange(from, to) {
      ranges.push([from, to]);
      // Ensure the next poll is due to refresh finality (four poll intervals).
      await Bun.sleep(10);
      return from <= 100 && to >= 100
        ? [block(100, tick === 1 ? "0xaaa" : "0xbbb")]
        : [];
    },
    async completeFresh() {},
  };
  const messages: StreamMessage<string>[] = [];
  try {
    for await (const message of createBlockStream({
      adapter, startingCursor: { orderKey: 99n }, options,
    })) messages.push(message);
  } catch (error) {
    if (error !== end) throw error;
  }

  const rollback = messages.findIndex(m => m._tag === "invalidate");
  const replacement = messages.findIndex(m =>
    m._tag === "data" && m.data.data[0]?.logs[0] === "0xbbb");
  const finalized = messages.findIndex(m =>
    m._tag === "finalize" && m.finalize.cursor.orderKey === 101n);
  expect(ranges[1]![0]).toBeLessThanOrEqual(100);
  expect(rollback).toBeGreaterThanOrEqual(0);
  expect(replacement).toBeGreaterThan(rollback);
  expect(finalized).toBeGreaterThan(replacement);
});

for (const failure of ["throw", "null"] as const) {
  it(`does not read or advance when startup cursor verification returns ${failure}`, async () => {
    let reads = 0;
    let unavailable = true;
    const adapter: ChainAdapter<string> = {
      label: "fixture",
      async fetchBlock() {
        if (!unavailable) return head(100, "0xbbb");
        if (failure === "throw") throw new Error("temporary RPC outage");
        return null;
      },
      async fetchHead() { reads++; return head(101); },
      async fetchFinalized() { reads++; return head(90); },
      async readRange() { reads++; return [block(100, "0xbbb")]; },
      async completeFresh() {},
    };
    const args = { adapter, startingCursor: { orderKey: 100n, uniqueKey: "0xaaa" }, options };
    const stream = createBlockStream(args);
    await expect(stream.next()).rejects.toThrow();
    expect(reads).toBe(0);

    // A subsequent runtime restart verifies the same durable cursor and rolls
    // back before it emits any replacement data or finality.
    unavailable = false;
    const retry = createBlockStream(args);
    expect((await retry.next()).value?._tag).toBe("invalidate");
    await retry.return(undefined);
  });
}

describe("a stale snapshot", () => {
  const run = async (staleReads: number, failure: () => Error = () =>
    new StaleSnapshotError("end block not found; retry the snapshot")) => {
    let heads = 0;
    let reads = 0;
    const warnings: string[] = [];
    const adapter: ChainAdapter<string> = {
      label: "fixture",
      async fetchBlock(n) { return head(n); },
      async fetchHead() { heads++; return head(100 + heads); },
      async fetchFinalized() { return head(90); },
      async readRange(_from, to) {
        if (++reads <= staleReads) throw failure();
        return [block(to, head(to).hash)];
      },
      async completeFresh() {},
    };
    const stream = createBlockStream({
      adapter, startingCursor: { orderKey: 99n },
      options: { ...options, onWarning: message => warnings.push(message) },
    });
    try {
      for await (const message of stream) {
        if (message._tag === "data") return { message, heads, warnings };
      }
      throw new Error("stream ended");
    } finally {
      await stream.return(undefined);
    }
  };

  it("is re-read from a fresh head instead of exiting", async () => {
    const { message, heads, warnings } = await run(2);
    expect(heads).toBe(3);
    expect(warnings).toEqual(["retrying a stale snapshot", "retrying a stale snapshot"]);
    if (message._tag !== "data") throw new Error("unreachable");
    expect(message.data.endCursor?.orderKey).toBe(103n);
  });

  it("still exits once the streak is too long to be the tip", async () => {
    await expect(run(MAX_STALE_SNAPSHOTS + 1)).rejects.toBeInstanceOf(StaleSnapshotError);
  });

  it("does not swallow other range failures", async () => {
    await expect(run(1, () => new Error("Invalid params"))).rejects.toThrow(/Invalid params/);
  });
});
