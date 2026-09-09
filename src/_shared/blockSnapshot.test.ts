import { expect, it } from "bun:test";
import type { ChainAdapter, ChainHead } from "./blockStream";
import { readSnapshot } from "./blockSnapshot";
import { commonStoredCursor } from "./cursorRecovery";
import { withRpcFailover } from "./rpcFailover";
import { parseRpcEnvelope } from "./rpcEnvelope";

const header = (number: number, hash = `0x${number.toString(16)}`): ChainHead => ({
  number, hash: hash as `0x${string}`, timestamp: new Date(1000), baseFeePerGas: 1n,
});
const adapter = (over: Partial<ChainAdapter<string>> = {}): ChainAdapter<string> => ({
  label: "fixture", fetchHead: async () => header(100),
  fetchBlock: async n => header(n), fetchFinalized: async () => null,
  readRange: async () => [], completeFresh: async () => {}, ...over,
});
const plan = { from: 91, to: 100, head: header(100) };

it("rejects a reorg during an empty range read", async () => {
  const rpc = adapter({ fetchBlock: async n => header(n, "0xbbb") });
  await expect(readSnapshot(rpc, plan, { number: 90, hash: null })).rejects.toThrow(/changed hash/);
});

it("resolves missing backfill tails before reading or emitting a range", async () => {
  let reads = 0;
  const rpc = adapter({ fetchBlock: async () => null, readRange: async () => { reads++; return []; } });
  await expect(readSnapshot(rpc, { ...plan, to: 99 }, { number: 90, hash: null })).rejects.toThrow(/valid block 99/);
  expect(reads).toBe(0);
});

it("detects a cursor reorg between startup verification and window seeding", async () => {
  const result = await readSnapshot(adapter(), plan, { number: 90, hash: "0xaaa" });
  expect(result.cursorChanged).toBe(true);
});

it("rejects head events from a different fork before completing them", async () => {
  let completions = 0;
  const rpc = adapter({
    readRange: async () => [{ header: { blockNumber: 100n, blockHash: "0xbbb", timestamp: new Date(1000), baseFeePerGas: null }, logs: ["event"] }],
    completeFresh: async () => { completions++; },
  });
  await expect(readSnapshot(rpc, plan, { number: 90, hash: null })).rejects.toThrow(/disagree/);
  expect(completions).toBe(0);
});

it("rejects an incorrect numbered header", async () => {
  await expect(readSnapshot(adapter({ fetchBlock: async () => header(101) }), plan, { number: 90, hash: null })).rejects.toThrow(/valid block 100/);
});

it("finds common persisted history beyond the polling window", async () => {
  const requested: number[] = [];
  const stored = [900, 600, 20].map(n => ({ orderKey: BigInt(n), uniqueKey: `0x${n.toString(16)}` }));
  const rpc = adapter({ fetchBlock: async n => { requested.push(n); return header(n, n > 20 ? "0xaaa" : "0x14"); } });
  expect(await commonStoredCursor(rpc, 1000, async before => stored.find(c => c.orderKey < BigInt(before)) ?? null)).toEqual(stored[2]!);
  expect(requested).toEqual([900, 600, 20]);
});

it("does not treat an unavailable recovery block as proof of a deeper reorg", async () => {
  await expect(commonStoredCursor(adapter({ fetchBlock: async () => null }), 100, async () => ({ orderKey: 90n, uniqueKey: "0x90" }))).rejects.toThrow(/verify recovery/);
});

it("restarts failover from the last emitted cursor instead of mixing range requests", async () => {
  const starts: bigint[] = [];
  const messages = [];
  for await (const message of withRpcFailover<string>([
    async function* () {
      yield { _tag: "invalidate", invalidate: { cursor: { orderKey: 50n, uniqueKey: "0x50" } } };
      throw new Error("provider failed during its next snapshot");
    },
    async function* (cursor) { starts.push(cursor.orderKey); yield { _tag: "heartbeat" }; },
  ], { orderKey: 100n }, () => {})) messages.push(message);
  expect(starts).toEqual([50n]);
  expect(messages.map(m => m._tag)).toEqual(["invalidate", "heartbeat"]);
});

it("rejects malformed successful HTTP responses and mismatched JSON-RPC IDs", () => {
  for (const body of [null, {}, [], { jsonrpc: "2.0", id: 2, result: 1 }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "x" } }]) {
    expect(() => parseRpcEnvelope(body)).toThrow();
  }
  expect(parseRpcEnvelope({ jsonrpc: "2.0", id: 1, result: null })).toEqual({ jsonrpc: "2.0", id: 1, result: null });
});


it("preserves an explicit initial indexing boundary when no stored events exist", async () => {
  expect(await commonStoredCursor(adapter(), 1000, async () => ({ orderKey: 500n })))
    .toEqual({ orderKey: 500n, uniqueKey: "0x1f4" });
});
