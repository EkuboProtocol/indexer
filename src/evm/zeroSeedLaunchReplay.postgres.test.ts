import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { encodeEventTopics } from "viem";
import { CORE_ABI } from "./abis_v3";
import { ZERO_SEED_LAUNCH_ABI } from "./abis_zero_seed_launch";
import shift from "postgres-shift";
import { DAO, NumericIntegerType } from "../_shared/dao";
import { parseEvmBlockHeader, processEvmBlock } from "../evm";
import { createLogProcessorsV3 } from "./logProcessorsV3";
import type { EvmLogProcessor } from "./logProcessorsShared";
import {
  groupLogsByBlock,
  type LogStreamFilter,
  type RawLog,
  type StreamBlock,
} from "./logStream";
import { floatSqrtRatioToFixed } from "./swapEvent";
import { resolveZeroSeedLaunchAddress } from "./zeroSeedLaunchConfig";
import { createZeroSeedLaunchProcessors } from "./zeroSeedLaunchProcessors";

// Replays logs that a local anvil chain actually emitted (see
// scripts/zeroSeedLaunchFixture.ts) through the indexer's own stream grouping,
// processors, DAO and the 00134 triggers on a real Postgres, and checks the
// indexed state against the chain state recorded after every block.
const SERVER = process.env.TEST_PG_CONNECTION_STRING;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type FixtureState = {
  blockNumber: number;
  pools: { label: string; poolId: `0x${string}`; poolStateWord: `0x${string}`; creatorFees: [string, string] }[];
  coreBalances: Record<string, string>;
};
type Branch = { blocks: { number: number; timestamp: number; actions: string[] }[]; logs: RawLog[]; states: FixtureState[] };
const fixture = JSON.parse(
  readFileSync(resolve(ROOT, "tests/fixtures/zero-seed-launch/local-chain.json"), "utf8"),
) as {
  chainId: number;
  provenance: { launchRuntimeKeccak: `0x${string}` };
  addresses: Record<string, `0x${string}`>;
  launches: Record<string, { token: string; quote: string; poolId: `0x${string}` }>;
  forkPoint: number;
  branches: { prefix: Branch; alternate: Branch; canonical: Branch };
};
const CHAIN_ID = BigInt(fixture.chainId);
const { prefix, alternate, canonical } = fixture.branches;

const POOL_INITIALIZED = encodeEventTopics({ abi: CORE_ABI, eventName: "PoolInitialized" })[0]!;
const LAUNCH_CREATED = encodeEventTopics({ abi: ZERO_SEED_LAUNCH_ABI, eventName: "LaunchCreated" })[0]!;

const unused = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;

function processorsFor(zeroSeedLaunchAddress?: `0x${string}`): EvmLogProcessor[] {
  return createLogProcessorsV3({
    mevCaptureAddress: unused(1),
    boostedFeesConcentratedAddress: unused(2),
    boostedFeesStableswapAddress: unused(3),
    coreAddress: fixture.addresses.core!,
    oracleAddress: unused(4),
    incentivesAddress: unused(5),
    tokenWrapperFactoryAddress: unused(6),
    auctionsAddress: unused(7),
    twammAddresses: [],
    ordersAddresses: [],
    positionsContracts: [],
    zeroSeedLaunchAddress,
  });
}

const LAUNCH = resolveZeroSeedLaunchAddress({
  chainId: CHAIN_ID,
  address: fixture.addresses.launch,
  runtimeCodehash: fixture.provenance.launchRuntimeKeccak,
  production: false,
});

const filtersOf = (processors: EvmLogProcessor[]): LogStreamFilter[] =>
  processors.map((p, ix) => ({ id: ix + 1, address: p.address, topics: p.filter.topics, strict: p.filter.strict }));

/** The runtime's per-block transaction: drop anything at or above the block, then write it. */
async function applyBlock(dao: DAO, processors: EvmLogProcessor[], block: StreamBlock) {
  const parsed = parseEvmBlockHeader(block)!;
  await dao.begin(async (tx) => {
    await tx.deleteOldBlockNumbers(parsed.header.number);
    await tx.insertBlock({
      number: parsed.header.number,
      hash: parsed.header.hash,
      time: new Date(parsed.header.timestamp),
      baseFeePerGas: null,
      numEvents: block.logs.reduce((n, log) => n + log.filterIds.length, 0),
    });
    await processEvmBlock(processors, parsed.block, parsed.header.number, tx);
  });
}

async function invalidateFrom(dao: DAO, blockNumber: number) {
  await dao.begin((tx) => tx.deleteOldBlockNumbers(blockNumber));
}

type Db = { sql: Sql<{ bigint: bigint; numeric: bigint }>; dao: DAO; name: string };

/** Signed 128-bit and 32-bit fields of Core's packed pool state word. */
function decodePoolState(word: `0x${string}`) {
  const n = BigInt(word);
  return {
    sqrtRatio: floatSqrtRatioToFixed(n >> 160n),
    tick: Number(BigInt.asIntN(32, n >> 128n)),
    liquidity: n & ((1n << 128n) - 1n),
  };
}

describe.skipIf(!SERVER)("zero-seed launch replay of local chain logs on Postgres", () => {
  const template = `zsl_template_${process.pid}_${Date.now()}`;
  const created: string[] = [];
  let admin: Sql;
  let counter = 0;

  beforeAll(async () => {
    admin = postgres(SERVER!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${template}`);
    const sql = postgres(urlFor(template), { max: 1, onnotice: () => {} });
    await shift({ sql, path: resolve(ROOT, "migrations") });
    await sql.end();
  }, 300_000);

  afterAll(async () => {
    for (const name of [...created, template])
      await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  function urlFor(database: string) {
    const url = new URL(SERVER!);
    url.pathname = `/${database}`;
    return url.toString();
  }

  async function freshDb(): Promise<Db> {
    const name = `${template}_${++counter}`;
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`);
    created.push(name);
    const sql = postgres(urlFor(name), {
      max: 1,
      onnotice: () => {},
      types: { bigint: postgres.BigInt, numeric: NumericIntegerType },
    }) as unknown as Db["sql"];
    await sql`INSERT INTO indexer_cursor (chain_id, order_key, unique_key, last_updated, fork_counter)
              VALUES (${CHAIN_ID}, 0, NULL, NOW(), 0)`;
    const dao = Reflect.construct(DAO, [sql, CHAIN_ID]) as DAO;
    return { sql, dao, name };
  }

  /** Applies a branch block by block, running `check` after each committed block. */
  async function replay(
    db: Db,
    branch: Branch,
    processors: EvmLogProcessor[],
    check?: (state: FixtureState, block: Branch["blocks"][number]) => Promise<void>,
  ) {
    const blocks = groupLogsByBlock(branch.logs, filtersOf(processors));
    for (const fixtureBlock of branch.blocks) {
      const block = blocks.find((b) => Number(b.header.blockNumber) === fixtureBlock.number);
      if (block) await applyBlock(db.dao, processors, block);
      const state = branch.states.find((s) => s.blockNumber === fixtureBlock.number)!;
      if (check) await check(state, fixtureBlock);
    }
  }

  // ----- committed-state invariants ---------------------------------------

  async function ledgerRows(db: Db) {
    return db.sql<{ pool_id: bigint; accrued0: bigint; accrued1: bigint; claimed0: bigint; claimed1: bigint; swap_count: bigint; claim_count: bigint; created_event_id: bigint; last_event_id: bigint }[]>`
      SELECT pk.pool_id, s.accrued0, s.accrued1, s.claimed0, s.claimed1, s.swap_count, s.claim_count,
             s.created_event_id, s.last_event_id
      FROM zero_seed_launch_states s JOIN pool_keys pk USING (pool_key_id)
      ORDER BY pk.pool_id`;
  }

  /** What recompute_zero_seed_launch_state would write, from the event tables alone. */
  async function recomputedLedger(db: Db) {
    return db.sql`
      SELECT pk.pool_id,
             COALESCE((SELECT SUM(fee_amount) FROM zero_seed_launch_swapped w WHERE w.pool_key_id = c.pool_key_id AND NOT fee_is_token1), 0) AS accrued0,
             COALESCE((SELECT SUM(fee_amount) FROM zero_seed_launch_swapped w WHERE w.pool_key_id = c.pool_key_id AND fee_is_token1), 0) AS accrued1,
             COALESCE((SELECT SUM(amount0) FROM zero_seed_launch_fees_claimed f WHERE f.pool_key_id = c.pool_key_id), 0) AS claimed0,
             COALESCE((SELECT SUM(amount1) FROM zero_seed_launch_fees_claimed f WHERE f.pool_key_id = c.pool_key_id), 0) AS claimed1,
             (SELECT COUNT(*) FROM zero_seed_launch_swapped w WHERE w.pool_key_id = c.pool_key_id)::int8 AS swap_count,
             (SELECT COUNT(*) FROM zero_seed_launch_fees_claimed f WHERE f.pool_key_id = c.pool_key_id)::int8 AS claim_count,
             c.event_id AS created_event_id,
             GREATEST(c.event_id,
                      (SELECT MAX(event_id) FROM zero_seed_launch_swapped w WHERE w.pool_key_id = c.pool_key_id),
                      (SELECT MAX(event_id) FROM zero_seed_launch_fees_claimed f WHERE f.pool_key_id = c.pool_key_id)) AS last_event_id
      FROM zero_seed_launch_created c JOIN pool_keys pk USING (pool_key_id)
      ORDER BY pk.pool_id`;
  }

  async function expectLedgerConsistent(db: Db) {
    const rows = await ledgerRows(db);
    expect(rows.map((r) => ({ ...r }))).toEqual((await recomputedLedger(db)).map((r) => ({ ...r })) as never);
    for (const r of rows) {
      for (const v of [r.accrued0, r.accrued1, r.claimed0, r.claimed1]) expect(v >= 0n).toBe(true);
      expect(r.claimed0 <= r.accrued0 && r.claimed1 <= r.accrued1).toBe(true);
    }
  }

  async function poolRow(db: Db, poolId: `0x${string}`) {
    const [row] = await db.sql<{ sqrt_ratio: bigint; tick: number; liquidity: bigint; accrued0: bigint; accrued1: bigint; claimed0: bigint; claimed1: bigint; balance0: bigint; balance1: bigint; token0: bigint; token1: bigint }[]>`
      SELECT ps.sqrt_ratio, ps.tick, ps.liquidity, s.accrued0, s.accrued1, s.claimed0, s.claimed1,
             pt.balance0, pt.balance1, pk.token0, pk.token1
      FROM pool_keys pk
               JOIN pool_states ps USING (pool_key_id)
               JOIN zero_seed_launch_states s USING (pool_key_id)
               JOIN pool_tvl pt USING (pool_key_id)
      WHERE pk.chain_id = ${CHAIN_ID} AND pk.pool_id = ${BigInt(poolId).toString()}::numeric`;
    return row;
  }

  /** Indexed Core state, fee ledger and Core token custody equal the chain at this block. */
  async function expectChainParity(db: Db, state: FixtureState) {
    const custody = new Map<bigint, bigint>();
    const add = (token: bigint, amount: bigint) => custody.set(token, (custody.get(token) ?? 0n) + amount);
    for (const pool of state.pools) {
      const row = await poolRow(db, pool.poolId);
      expect(row, `${pool.label} indexed`).toBeDefined();
      expect({ sqrtRatio: row!.sqrt_ratio, tick: row!.tick, liquidity: row!.liquidity })
        .toEqual(decodePoolState(pool.poolStateWord));
      const unclaimed = [row!.accrued0 - row!.claimed0, row!.accrued1 - row!.claimed1];
      expect(unclaimed.map(String)).toEqual(pool.creatorFees);
      // Core holds each pool's reserves (Core events only) plus the
      // extension's saved fee balance; the two ledgers never mix.
      add(row!.token0, row!.balance0 + unclaimed[0]!);
      add(row!.token1, row!.balance1 + unclaimed[1]!);
    }
    const expected = Object.fromEntries(Object.entries(state.coreBalances).map(([t, v]) => [BigInt(t).toString(), v]));
    expect(Object.fromEntries([...custody].map(([t, v]) => [t.toString(), v.toString()]))).toEqual(expected);
  }

  async function expectPoolLastEventId(db: Db) {
    const rows = await db.sql<{ ok: boolean }[]>`
      SELECT plei.last_event_id = GREATEST(ps.last_event_id, s.created_event_id) AS ok
      FROM zero_seed_launch_states s
               JOIN pool_states ps USING (pool_key_id)
               JOIN pool_last_event_id plei USING (pool_key_id)`;
    const [{ n }] = await db.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM zero_seed_launch_states`;
    expect(rows.length).toBe(n);
    expect(rows.every((r) => r.ok)).toBe(true);
  }

  async function check(db: Db, state: FixtureState) {
    await expectLedgerConsistent(db);
    await expectChainParity(db, state);
    await expectPoolLastEventId(db);
  }

  /** Everything the API and quoter read, keyed by pool id rather than serial pool_key_id. */
  async function dump(db: Db) {
    const q = (text: string) => db.sql.unsafe(text).then((rows) => rows.map((r) => ({ ...r })));
    return {
      blocks: await q(`SELECT block_number, block_hash, block_time, num_events FROM blocks ORDER BY block_number`),
      created: await q(`SELECT c.*, NULL AS pool_key_id FROM zero_seed_launch_created c ORDER BY event_id`),
      swapped: await q(`SELECT w.*, NULL AS pool_key_id FROM zero_seed_launch_swapped w ORDER BY event_id`),
      claimed: await q(`SELECT f.*, NULL AS pool_key_id FROM zero_seed_launch_fees_claimed f ORDER BY event_id`),
      states: await ledgerRows(db).then((rows) => rows.map((r) => ({ ...r }))),
      pools: await q(`SELECT pk.pool_id, ps.sqrt_ratio, ps.tick, ps.liquidity, ps.last_event_id, plei.last_event_id AS plei, pt.balance0, pt.balance1
                      FROM pool_keys pk JOIN pool_states ps USING (pool_key_id) JOIN pool_last_event_id plei USING (pool_key_id)
                      JOIN pool_tvl pt USING (pool_key_id) ORDER BY pk.pool_id`),
      view: await q(`SELECT pool_id, sqrt_ratio, tick, liquidity, last_event_id, ticks, zero_seed_launch_token_is_token1,
                       zero_seed_launch_tick_lower, zero_seed_launch_tick_upper, zero_seed_launch_liquidity,
                       zero_seed_launch_trading_start, zero_seed_launch_fee_duration, zero_seed_launch_initial_fee,
                       zero_seed_launch_final_fee, is_zero_seed_launch_pool
                     FROM all_pool_states_view v JOIN pool_keys USING (pool_key_id) ORDER BY pool_id`),
    };
  }

  const LAUNCH_ON = () => processorsFor(LAUNCH);

  // ----- scenarios ---------------------------------------------------------

  let canonicalDump: Awaited<ReturnType<typeof dump>>;

  test("the pinned fixture launch resolves", () => {
    expect(LAUNCH).toBe(fixture.addresses.launch.toLowerCase() as `0x${string}`);
  });

  test("canonical replay equals chain state after every block", async () => {
    const db = await freshDb();
    const processors = LAUNCH_ON();
    await replay(db, prefix, processors, (state) => check(db, state));
    await replay(db, canonical, processors, (state) => check(db, state));
    canonicalDump = await dump(db);
    expect(canonicalDump.created.length).toBe(3);
    expect(canonicalDump.swapped.length).toBeGreaterThan(10);
    expect(canonicalDump.claimed.length).toBe(5);
    await db.sql.end();
  }, 120_000);

  test("every swap: fee rate is feeAt at the block, and launch delta = Core delta + fee on one side", async () => {
    const db = await freshDb();
    await replay(db, prefix, LAUNCH_ON());
    await replay(db, canonical, LAUNCH_ON());
    const rows = await db.sql<{ ok_rate: boolean; ok_fee_side: boolean; ok_other: boolean; core_found: boolean; zero_fill: boolean }[]>`
      SELECT w.fee_rate = zero_seed_launch_fee_at(c.trading_start, c.fee_duration, c.initial_fee, c.final_fee,
                                                   EXTRACT(EPOCH FROM b.block_time)::int8) AS ok_rate,
             (CASE WHEN w.fee_is_token1 THEN w.delta1 - s.delta1 ELSE w.delta0 - s.delta0 END) = w.fee_amount AS ok_fee_side,
             (CASE WHEN w.fee_is_token1 THEN w.delta0 = s.delta0 ELSE w.delta1 = s.delta1 END) AS ok_other,
             s.event_id IS NOT NULL AS core_found,
             w.delta0 = 0 AND w.delta1 = 0 AND w.fee_amount = 0 AS zero_fill
      FROM zero_seed_launch_swapped w
               JOIN zero_seed_launch_created c USING (pool_key_id)
               JOIN blocks b ON b.chain_id = w.chain_id AND b.block_number = w.block_number
               LEFT JOIN LATERAL (SELECT * FROM swaps s
                                  WHERE s.chain_id = w.chain_id AND s.pool_key_id = w.pool_key_id
                                    AND s.transaction_hash = w.transaction_hash AND s.event_id < w.event_id
                                  ORDER BY s.event_id DESC LIMIT 1) s ON TRUE`;
    expect(rows.length).toBeGreaterThan(10);
    // A zero fill (the two deliberate no-bid sells) moves nothing, and Core
    // emits no swap log for it; every other launch swap has its Core swap.
    expect(rows.filter((r) => r.zero_fill).map((r) => r.core_found)).toEqual([false, false]);
    expect(rows.filter((r) => !r.zero_fill && !(r.core_found && r.ok_rate && r.ok_fee_side && r.ok_other))).toEqual([]);
    await db.sql.end();
  }, 120_000);

  test("orders and decimals: generated pool ticks, view columns and the two tick entries", async () => {
    const db = await freshDb();
    await replay(db, prefix, LAUNCH_ON());
    await replay(db, canonical, LAUNCH_ON());
    const rows = await db.sql<{ token_is_token1: boolean; quote_decimals_6: boolean; ok: boolean }[]>`
      SELECT c.token_is_token1,
             c.quote_token = ${BigInt(fixture.addresses.quote6!).toString()}::numeric AS quote_decimals_6,
             v.is_zero_seed_launch_pool
               AND v.zero_seed_launch_tick_lower = c.tick_lower AND v.zero_seed_launch_tick_upper = c.tick_upper
               AND v.zero_seed_launch_liquidity = c.liquidity AND v.zero_seed_launch_token_is_token1 = c.token_is_token1
               AND v.zero_seed_launch_trading_start = c.trading_start AND v.zero_seed_launch_fee_duration = c.fee_duration
               AND v.zero_seed_launch_initial_fee = c.initial_fee AND v.zero_seed_launch_final_fee = c.final_fee
               AND v.ticks = JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT('t', c.tick_lower, 'd', c.liquidity::TEXT),
                                               JSONB_BUILD_OBJECT('t', c.tick_upper, 'd', (-c.liquidity)::TEXT))
               AND DIV(c.position_id, 18446744073709551616) = 0
               AND MOD(DIV(c.position_id, 4294967296), 4294967296) = MOD(c.tick_lower::int8 + 4294967296, 4294967296)
               AND MOD(c.position_id, 4294967296) = MOD(c.tick_upper::int8 + 4294967296, 4294967296) AS ok
      FROM zero_seed_launch_created c JOIN all_pool_states_view v USING (pool_key_id)
      ORDER BY c.event_id`;
    expect(rows.map((r) => [r.token_is_token1, r.quote_decimals_6])).toEqual([
      [false, false], // l1: token0, 18/18
      [true, true], // l2: token1, 18/6
      [false, true], // l4: token0, 18/6
    ]);
    expect(rows.every((r) => r.ok)).toBe(true);
    await db.sql.end();
  }, 120_000);

  test("reorg: an alternate fork across a creation, then the canonical branch, equals a straight replay", async () => {
    const db = await freshDb();
    const processors = LAUNCH_ON();
    await replay(db, prefix, processors);
    await replay(db, alternate, processors, (state) => check(db, state));
    // The alternate fork created l3, which the canonical chain never did.
    const [{ l3 }] = await db.sql<{ l3: number }[]>`
      SELECT COUNT(*)::int AS l3 FROM zero_seed_launch_created WHERE pool_id = ${BigInt(fixture.launches.l3!.poolId).toString()}::numeric`;
    expect(l3).toBe(1);
    await invalidateFrom(db.dao, fixture.forkPoint + 1);
    await expectLedgerConsistent(db);
    await replay(db, canonical, processors, (state) => check(db, state));
    expect(await dump(db)).toEqual(canonicalDump);
    // l3's pool key outlives the fork, as every Core pool key does, but it has
    // no state, no launch row and is not in the view.
    const [{ visible }] = await db.sql<{ visible: number }[]>`
      SELECT COUNT(*)::int AS visible FROM all_pool_states_view v JOIN pool_keys pk USING (pool_key_id)
      WHERE pk.pool_id = ${BigInt(fixture.launches.l3!.poolId).toString()}::numeric`;
    expect(visible).toBe(0);
    await db.sql.end();
  }, 120_000);

  test("reorg from the first creation block empties every launch table, and replay restores it", async () => {
    const db = await freshDb();
    const processors = LAUNCH_ON();
    await replay(db, prefix, processors);
    await replay(db, canonical, processors);
    const creationBlock = prefix.blocks.find((b) => b.actions.includes("create l1"))!.number;
    await invalidateFrom(db.dao, creationBlock);
    const counts = await db.sql<{ n: number }[]>`
      SELECT (SELECT COUNT(*) FROM zero_seed_launch_created) + (SELECT COUNT(*) FROM zero_seed_launch_swapped)
           + (SELECT COUNT(*) FROM zero_seed_launch_fees_claimed) + (SELECT COUNT(*) FROM zero_seed_launch_states) AS n`;
    expect(Number(counts[0]!.n)).toBe(0);
    const [{ n }] = await db.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM all_pool_states_view WHERE is_zero_seed_launch_pool`;
    expect(n).toBe(0);
    await replay(db, { ...prefix, blocks: prefix.blocks.filter((b) => b.number >= creationBlock) }, processors);
    await replay(db, canonical, processors);
    expect(await dump(db)).toEqual(canonicalDump);
    await db.sql.end();
  }, 120_000);

  test("deleting swaps before claims, claims before swaps, or whole blocks: committed ledgers never go negative", async () => {
    const db = await freshDb();
    const processors = LAUNCH_ON();
    await replay(db, prefix, processors);
    await replay(db, canonical, processors);
    for (const first of ["zero_seed_launch_swapped", "zero_seed_launch_fees_claimed"]) {
      const second = first === "zero_seed_launch_swapped" ? "zero_seed_launch_fees_claimed" : "zero_seed_launch_swapped";
      await db.sql.begin(async (tx) => {
        await tx.unsafe(`DELETE FROM ${first} WHERE block_number > ${fixture.forkPoint}`);
        await tx.unsafe(`DELETE FROM ${second} WHERE block_number > ${fixture.forkPoint}`);
        await tx.unsafe(`DELETE FROM blocks WHERE block_number > ${fixture.forkPoint}`);
      });
      await expectLedgerConsistent(db);
      await check(db, prefix.states.at(-1)!);
      await replay(db, canonical, processors);
      expect(await dump(db)).toEqual(canonicalDump);
    }
    // Each canonical block alone, newest first: every intermediate commit is consistent.
    for (const block of [...canonical.blocks].reverse()) {
      await invalidateFrom(db.dao, block.number);
      await expectLedgerConsistent(db);
      const state = [...prefix.states, ...canonical.states].filter((s) => s.blockNumber < block.number).at(-1)!;
      await expectChainParity(db, state);
    }
    await db.sql.end();
  }, 120_000);

  test("redelivery: re-processing a block, or re-sending its launch logs, changes nothing", async () => {
    const db = await freshDb();
    const processors = LAUNCH_ON();
    await replay(db, prefix, processors);
    await replay(db, canonical, processors);
    const blocks = groupLogsByBlock([...prefix.logs, ...canonical.logs], filtersOf(processors));
    // the runtime's path: a block arriving again is deleted and rewritten
    for (const block of blocks.slice(-4)) await applyBlock(db.dao, processors, block);
    expect(await dump(db)).toEqual(canonicalDump);
    // a duplicate launch log inside the same transaction is ignored
    const launchOnly = processors.filter((p) => p.address.toLowerCase() === LAUNCH);
    const launchFilters = filtersOf(launchOnly);
    for (const block of groupLogsByBlock([...prefix.logs, ...canonical.logs], launchFilters)) {
      await db.dao.begin((tx) => processEvmBlock(launchOnly, block, Number(block.header.blockNumber), tx));
    }
    expect(await dump(db)).toEqual(canonicalDump);
    await db.sql.end();
  }, 120_000);

  test("orphans are refused: a launch swap whose creation is absent, or a launch on an unregistered pool", async () => {
    const db = await freshDb();
    const processors = LAUNCH_ON();
    await replay(db, prefix, processors);
    const blocks = groupLogsByBlock(canonical.logs, filtersOf(processors));
    // Drop l4's LaunchCreated from the block that created it: its later swaps are orphans.
    const l4Pool = fixture.launches.l4!.poolId;
    const created = blocks[0]!;
    const withoutCreation = { ...created, logs: created.logs.filter((l) => !(l.topics[0] === LAUNCH_CREATED && l.topics[1] === l4Pool)) };
    expect(withoutCreation.logs.length).toBe(created.logs.length - 1);
    await applyBlock(db.dao, processors, withoutCreation);
    await expect(applyBlock(db.dao, processors, blocks[1]!)).rejects.toThrow(/without LaunchCreated/);
    // The refused block left nothing behind.
    const [{ n }] = await db.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM blocks WHERE block_number = ${Number(blocks[1]!.header.blockNumber)}`;
    expect(n).toBe(0);
    await expectLedgerConsistent(db);

    // A launch processor without Core's pool registration (a config bug): LaunchCreated is refused.
    const db2 = await freshDb();
    const unregistered = processorsFor(undefined).concat(
      createZeroSeedLaunchProcessors({ coreAddress: fixture.addresses.core!, zeroSeedLaunchAddress: LAUNCH }),
    );
    for (const block of groupLogsByBlock(prefix.logs, filtersOf(unregistered))) {
      if (block.logs.some((l) => l.topics[0] === LAUNCH_CREATED)) {
        await expect(applyBlock(db2.dao, unregistered, block)).rejects.toThrow(/not a registered launch pool/);
        break;
      }
      await applyBlock(db2.dao, unregistered, block);
    }
    await db.sql.end();
    await db2.sql.end();
  }, 120_000);

  test("repair: recompute_zero_seed_launch_state restores a corrupted ledger exactly", async () => {
    const db = await freshDb();
    await replay(db, prefix, LAUNCH_ON());
    await replay(db, canonical, LAUNCH_ON());
    const before = await ledgerRows(db);
    await db.sql`UPDATE zero_seed_launch_states SET accrued0 = accrued0 + 7, claim_count = 99, last_event_id = 0`;
    await db.sql`SELECT recompute_zero_seed_launch_state(pool_key_id) FROM zero_seed_launch_created`;
    expect(await ledgerRows(db)).toEqual(before);
    await db.sql.end();
  }, 120_000);

  test("claims do not move pool_last_event_id; creation and swaps do", async () => {
    const db = await freshDb();
    const processors = LAUNCH_ON();
    await replay(db, prefix, processors);
    await replay(db, { ...alternate, blocks: alternate.blocks.slice(0, 2) }, processors);
    const read = () => db.sql<{ pool_id: bigint; plei: bigint }[]>`
      SELECT pk.pool_id, plei.last_event_id AS plei FROM pool_last_event_id plei JOIN pool_keys pk USING (pool_key_id) ORDER BY 1`;
    const before = await read();
    // alternate's last block holds only claims
    expect(alternate.blocks.at(-1)!.actions.every((a) => a.startsWith("claim"))).toBe(true);
    await replay(db, { ...alternate, blocks: alternate.blocks.slice(2) }, processors);
    const [{ claims }] = await db.sql<{ claims: number }[]>`
      SELECT COUNT(*)::int AS claims FROM zero_seed_launch_fees_claimed WHERE block_number = ${alternate.blocks.at(-1)!.number}`;
    expect(claims).toBe(2);
    expect(await read()).toEqual(before);
    await expectPoolLastEventId(db);
    await db.sql.end();
  }, 120_000);

  test("with no launch address, launch support is off: Core pools index, launch tables stay empty", async () => {
    const db = await freshDb();
    const processors = processorsFor(undefined);
    expect(processors.some((p) => p.address.toLowerCase() === fixture.addresses.launch!.toLowerCase())).toBe(false);
    await replay(db, prefix, processors);
    await replay(db, canonical, processors);
    const [row] = await db.sql<{ pools: number; launch_rows: number; flagged: number }[]>`
      SELECT (SELECT COUNT(*)::int FROM all_pool_states_view) AS pools,
             (SELECT COUNT(*)::int FROM zero_seed_launch_pool_keys) + (SELECT COUNT(*)::int FROM zero_seed_launch_created)
               + (SELECT COUNT(*)::int FROM zero_seed_launch_swapped) + (SELECT COUNT(*)::int FROM zero_seed_launch_states) AS launch_rows,
             (SELECT COUNT(*)::int FROM all_pool_states_view WHERE is_zero_seed_launch_pool) AS flagged`;
    expect(row).toEqual({ pools: 3, launch_rows: 0, flagged: 0 });
    await db.sql.end();
  }, 120_000);
});
