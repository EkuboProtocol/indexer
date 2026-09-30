import { expect, it } from "bun:test";
import {
  createBlockStream,
  type ChainAdapter,
  type ChainHead,
  type StreamBlock,
  type StreamMessage,
} from "./blockStream";

// Outage-behaviour tests contributed in the CTO review of indexer#221 (EKU-515).

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

const base = {
  pollIntervalMs: 1,
  maxPollIntervalMs: 4,
  finalizedRefreshIntervalMs: 1,
  maxLogRangeBlocks: 100,
  heartbeatIntervalMs: 1_000_000,
};

it("does not spend the budget across failures separated by successes, and resets the backoff", async () => {
  let heads = 0;
  let reads = 0;
  const warnings: Record<string, unknown>[] = [];
  const adapter: ChainAdapter<string> = {
    label: "fixture",
    async fetchBlock(n) { return head(n); },
    async fetchHead() { return head(100 + ++heads); },
    async fetchFinalized() { return head(90); },
    async readRange(from, to) {
      // Every other read fails, each slow enough that the run outlasts the budget.
      await Bun.sleep(2);
      if (++reads % 2 === 1) throw new Error("refused");
      return Array.from({ length: to - from + 1 }, (_, i) => block(from + i, head(from + i).hash));
    },
    async completeFresh() {},
  };
  const stream = createBlockStream({
    adapter, startingCursor: { orderKey: 99n },
    options: {
      ...base,
      providerOutageBudgetMs: 20,
      onWarning: (m, d) => { if (m === "provider read failed; backing off") warnings.push(d); },
    },
  });
  const started = Date.now();
  let data = 0;
  for await (const message of stream) {
    if (message._tag === "invalidate") throw new Error("spurious rollback");
    if (message._tag === "data" && ++data >= 40 && reads >= 80) break;
  }
  expect(Date.now() - started).toBeGreaterThan(20 * 3);
  expect(warnings.length).toBeGreaterThanOrEqual(39);
  expect(new Set(warnings.map(w => w.attempt))).toEqual(new Set([1]));
  expect(new Set(warnings.map(w => w.retryInMs))).toEqual(new Set([1]));
});

it("a reorg of the cursor block during an outage is rolled back on recovery", async () => {
  let heads = 0;
  let reads = 0;
  let reorged = false;
  const hashOf = (n: number) => (reorged && n >= 101 ? `0xb${n}` : `0xa${n}`);
  const adapter: ChainAdapter<string> = {
    label: "fixture",
    async fetchBlock(n) { return head(n, hashOf(n)); },
    async fetchHead() { const n = 100 + ++heads; return head(n, hashOf(n)); },
    async fetchFinalized() { return null; },
    async readRange(from, to) {
      const n = ++reads;
      if (n >= 2 && n <= 4) { reorged = true; throw new Error("refused"); }
      return Array.from({ length: to - from + 1 }, (_, i) => block(from + i, hashOf(from + i)));
    },
    async completeFresh() {},
  };
  const stream = createBlockStream({
    adapter, startingCursor: { orderKey: 99n, uniqueKey: "0xa99" }, options: base,
  });
  const messages: StreamMessage<string>[] = [];
  for await (const message of stream) {
    messages.push(message);
    if (reads >= 7 && message._tag === "data") break;
  }
  const tags = messages.map(m =>
    m._tag === "data" ? `data:${m.data.endCursor.orderKey}:${m.data.endCursor.uniqueKey}`
    : m._tag === "invalidate" ? `invalidate:${m.invalidate.cursor.orderKey}` : m._tag);
  expect(tags.slice(0, 2)).toEqual(["data:100:0xa100", "data:101:0xa101"]);
  expect(tags[2]).toBe("invalidate:100");
  expect(tags[3]).toBe("data:101:0xb101");
});
