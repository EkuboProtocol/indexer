import { afterEach, beforeEach, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { ChainAdapter, ChainHead } from "./blockStream";
import { commonStoredCursor } from "./cursorRecovery";
import { DAO, type IndexerCursor } from "./dao";
import {
  assertRecoveryWalkAllowed,
  assertRollbackDepthAllowed,
  parseMaxReorgDepth,
  RollbackRefusedError,
  type RollbackGuardDao,
} from "./rollbackGuard";

const chainId = 1n;
const hex = (n: number) => `0x${n.toString(16)}`;
const header = (number: number, hash = hex(number)): ChainHead => ({
  number, hash: hash as `0x${string}`, timestamp: new Date(1000), baseFeePerGas: null,
});
const adapter = (fetchBlock: ChainAdapter<string>["fetchBlock"]): ChainAdapter<string> => ({
  label: "fixture", fetchHead: async () => header(1000), fetchBlock,
  fetchFinalized: async () => null, readRange: async () => [], completeFresh: async () => {},
});

let db: PGlite;
let dao: DAO;

// Stored event-bearing blocks 100, 200, ..., 1000 with their canonical hashes.
const STORED = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
const CURSOR = { orderKey: 1000n, uniqueKey: hex(1000) };

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE indexer_cursor (
      chain_id bigint PRIMARY KEY, order_key bigint, unique_key numeric,
      last_updated timestamptz, finalized_order_key bigint, finalized_unique_key numeric,
      head_block_number bigint, head_block_hash numeric, head_block_time timestamptz,
      head_base_fee_per_gas numeric
    );
    CREATE TABLE blocks (chain_id bigint, block_number bigint, block_hash numeric, PRIMARY KEY (chain_id, block_number));
    INSERT INTO blocks SELECT 1, n, n FROM unnest(ARRAY[${STORED.join(",")}]) AS n;
    INSERT INTO blocks VALUES (2, 50, 50);
  `);
  // Execute the DAO's actual parameterized SQL against Postgres in PGlite.
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((q, part, i) => q + (i ? `$${i}` : "") + part, "");
    const result = await db.query(query, values.map(v => typeof v === "bigint" ? v.toString() : v));
    return Object.assign(result.rows, { count: result.affectedRows });
  }, { typed: (value: unknown) => value });
  dao = Reflect.construct(DAO, [sql, chainId]) as DAO;
  await dao.writeCursor(CURSOR, { orderKey: 0n });
});

afterEach(async () => {
  await db.close();
});

const finalize = (n: number) => dao.updateFinalizedCursor(CURSOR, { orderKey: BigInt(n), uniqueKey: hex(n) });
const storedCount = async () =>
  Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM blocks WHERE chain_id = 1")).rows[0]!.n);
const refusalOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RollbackRefusedError);
    return (error as RollbackRefusedError).refusal;
  }
  throw new Error("expected the rollback to be refused");
};

/** The runtime's `loadPreviousCursor`, with the walk guard in front of it. */
const guardedLoadPrevious = (maxReorgDepth: number | null) => async (before: number) => {
  await assertRecoveryWalkAllowed(dao, { chainId, from: CURSOR, before, maxReorgDepth });
  return dao.loadPreviousBlockCursor(before);
};

// A provider answering for another chain, or with corrupt hashes: nothing stored verifies.
const wrongChain = (requested: number[]) => adapter(async n => {
  requested.push(n);
  return header(n, "0xbad");
});

it("reproduces the unbounded walk: a wrong-chain provider rolls recovery back to block zero", async () => {
  const requested: number[] = [];
  const target = await commonStoredCursor(wrongChain(requested), 1001, n => dao.loadPreviousBlockCursor(n));
  // Rolling back to zero is what the runtime turns into DELETE ... WHERE block_number >= 1.
  expect(target).toEqual({ orderKey: 0n });
  expect(requested).toEqual([...STORED].reverse());
});

it("stops the walk at the first non-canonical finalized block, before any delete", async () => {
  await finalize(900);
  const requested: number[] = [];
  const refusal = await refusalOf(commonStoredCursor(wrongChain(requested), 1001, guardedLoadPrevious(null)));
  expect(refusal).toMatchObject({
    reason: "finalized_history_not_canonical", fromBlock: 1000, toBlock: null,
    finalizedBlock: 900, failedFinalizedBlock: 900, maxReorgDepth: null,
  });
  expect(requested).toEqual([1000, 900]);
  expect(await storedCount()).toBe(STORED.length);
});

it("stops the walk once it is deeper than MAX_REORG_DEPTH when no finality is persisted", async () => {
  const requested: number[] = [];
  const refusal = await refusalOf(commonStoredCursor(wrongChain(requested), 1001, guardedLoadPrevious(250)));
  expect(refusal).toMatchObject({ reason: "exceeds_max_reorg_depth", depth: 301, finalizedBlock: null });
  expect(requested).toEqual([1000, 900, 800, 700]);
});

it("keeps the existing walk to verified history for a real reorg above finality", async () => {
  await finalize(800);
  // Blocks above 800 were reorged; 800 and below are canonical.
  const rpc = adapter(async n => header(n, n > 800 ? "0xf0f0" : hex(n)));
  const target = await commonStoredCursor(rpc, 1001, guardedLoadPrevious(null));
  expect(target).toEqual({ orderKey: 800n, uniqueKey: hex(800) });
  assertRollbackDepthAllowed({ chainId, from: CURSOR, to: 800, maxReorgDepth: 200 });
});

it("still lets a window rollback re-index canonical finalized blocks", () => {
  // A block the store missed, or events a newly added filter address now
  // matches: the stream rolls back below them even under finality, and only
  // the operator's depth limit applies to that delete.
  assertRollbackDepthAllowed({ chainId, from: CURSOR, to: 899, maxReorgDepth: null });
  assertRollbackDepthAllowed({ chainId, from: CURSOR, to: 899, maxReorgDepth: 101 });
});

it("walks to a verified block below finality when only blocks above it reorged", async () => {
  await finalize(950);
  const rpc = adapter(async n => header(n, n > 950 ? "0xf0f0" : hex(n)));
  expect(await commonStoredCursor(rpc, 1001, guardedLoadPrevious(null))).toEqual({ orderKey: 900n, uniqueKey: hex(900) });
});

it("applies MAX_REORG_DEPTH to deletes only when set, and only beyond it", async () => {
  assertRollbackDepthAllowed({ chainId, from: CURSOR, to: 0, maxReorgDepth: null });
  assertRollbackDepthAllowed({ chainId, from: CURSOR, to: 936, maxReorgDepth: 64 });
  expect(await refusalOf(Promise.resolve().then(() =>
    assertRollbackDepthAllowed({ chainId, from: CURSOR, to: 935, maxReorgDepth: 64 }))))
    .toMatchObject({ reason: "exceeds_max_reorg_depth", fromBlock: 1000, toBlock: 935, depth: 65, maxReorgDepth: 64 });
});

it("does not query or refuse before recovery has rejected anything", async () => {
  const untouchable = new Proxy({}, {
    get: () => { throw new Error("must not query"); },
  }) as RollbackGuardDao;
  const from: IndexerCursor = { orderKey: 1000n };
  assertRollbackDepthAllowed({ chainId, from, to: 1000, maxReorgDepth: 1 });
  await assertRecoveryWalkAllowed(untouchable, { chainId, from, before: 1001, maxReorgDepth: 1 });
});

it("states the refusal without anything but block numbers and settings", () => {
  const error = new RollbackRefusedError({
    reason: "exceeds_max_reorg_depth", fromBlock: 1000, toBlock: 0, depth: 1000,
    finalizedBlock: null, failedFinalizedBlock: null, maxReorgDepth: 64,
  });
  expect(error.message).toBe(
    "Refusing rollback (exceeds_max_reorg_depth) from block 1000 to block 0, depth at least 1000; " +
      "finalized block unknown, MAX_REORG_DEPTH 64. Nothing was deleted. Check the RPC endpoint before any manual recovery.",
  );
});

it("parses MAX_REORG_DEPTH strictly", () => {
  expect(parseMaxReorgDepth(undefined)).toBeNull();
  expect(parseMaxReorgDepth(" ")).toBeNull();
  expect(parseMaxReorgDepth("128")).toBe(128);
  for (const raw of ["0", "-1", "1.5", "abc", "1e400"]) {
    expect(() => parseMaxReorgDepth(raw)).toThrow(/MAX_REORG_DEPTH/);
  }
});
