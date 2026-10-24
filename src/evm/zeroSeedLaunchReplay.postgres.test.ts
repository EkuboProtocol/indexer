import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  type Abi,
  type AbiEvent,
} from "viem";
import { CORE_ABI } from "./abis_v3";
import {
  ZERO_SEED_LAUNCH_ABI,
  ZERO_SEED_LAUNCH_PERIPHERY_ABI,
} from "./abis_zero_seed_launch";
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
  type StreamLog,
} from "./logStream";
import { floatSqrtRatioToFixed } from "./swapEvent";
import { resolveZeroSeedLaunchPin } from "./zeroSeedLaunchConfig";
import {
  createZeroSeedLaunchProcessors,
  zeroSeedLaunchCatchUpGuard,
} from "./zeroSeedLaunchProcessors";

// Replays logs that a local anvil chain actually emitted (see
// scripts/zeroSeedLaunchFixture.ts) through the indexer's own stream grouping,
// processors, DAO and the 00140 triggers on a real Postgres, and checks the
// indexed state against the chain state recorded after every block: Core
// pool state and custody (native ETH and ERC-20), the creator fee ledger,
// the periphery owner of every launch and the contract's feeAt. One extension
// serves native-ETH and ERC-20 quote launches; each launch's requested,
// installed and sink supply are checked against the chain.
/** Awaits `expect(promise).rejects.toThrow(error)`: bun-types declares the
 * matcher as returning void, but it returns a promise that must be awaited. */
const expectRejects = (promise: Promise<unknown>, error: RegExp) =>
  expect(promise).rejects.toThrow(error) as unknown as Promise<void>;

const SERVER = process.env.TEST_PG_CONNECTION_STRING;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type FixturePool = {
  label: string;
  poolId: `0x${string}`;
  poolStateWord: `0x${string}`;
  creatorFees: [string, string];
  launchOwner: `0x${string}`;
  controller: `0x${string}`;
  feeAtBlockTime: string;
  totalSupply: string;
  sinkBalance: string;
};
type FixtureState = {
  blockNumber: number;
  pools: FixturePool[];
  coreBalances: Record<string, string>;
};
type Branch = {
  blocks: { number: number; timestamp: number; actions: string[] }[];
  logs: RawLog[];
  states: FixtureState[];
};
type Instance = {
  label: string;
  extension: `0x${string}`;
  periphery: `0x${string}`;
  extensionRuntimeKeccak: `0x${string}`;
  deploymentBlock: number;
};
const fixture = JSON.parse(
  readFileSync(
    resolve(ROOT, "tests/fixtures/zero-seed-launch/local-chain.json"),
    "utf8",
  ),
) as {
  chainId: number;
  addresses: Record<string, `0x${string}`>;
  instances: Instance[];
  launches: Record<
    string,
    {
      token: string;
      quote: string;
      quoteKind: "native" | "erc20";
      extension: `0x${string}`;
      periphery: `0x${string}`;
      poolId: `0x${string}`;
      requestedSupply: string;
      installedSupply: string;
      sinkSupply: string;
      liquidity: string;
    }
  >;
  installations: Record<string, { owner: `0x${string}` }>;
  forkPoint: number;
  branches: { prefix: Branch; alternate: Branch; canonical: Branch };
};
const CHAIN_ID = BigInt(fixture.chainId);
const { prefix, alternate, canonical } = fixture.branches;
const CORE = fixture.addresses.core;

const topic = (abi: Abi, eventName: string) =>
  encodeEventTopics({ abi, eventName })[0] as `0x${string}`;
/** Strictly decoded args of a launch log, every field present. */
const decodeArgs = <T>(
  abi: Abi,
  eventName: string,
  log: Pick<RawLog, "topics" | "data">,
): T =>
  decodeEventLog({
    abi,
    eventName,
    topics: log.topics as [`0x${string}`],
    data: log.data,
    strict: true,
  }).args as T;
type Hex = `0x${string}`;
const LAUNCH_CREATED = topic(ZERO_SEED_LAUNCH_ABI, "LaunchCreated");
const CREATOR_FEES_CLAIMED = topic(ZERO_SEED_LAUNCH_ABI, "CreatorFeesClaimed");
const OWNER_CHANGED = topic(
  ZERO_SEED_LAUNCH_PERIPHERY_ABI,
  "LaunchOwnerChanged",
);
const FEES_PAID = topic(ZERO_SEED_LAUNCH_PERIPHERY_ABI, "LaunchFeesClaimed");

const unused = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, "0")}`;

// The instance resolves through the production configuration path.
const PINS = fixture.instances.map((i) =>
  resolveZeroSeedLaunchPin({
    coreAddress: CORE,
    chainId: CHAIN_ID,
    address: i.extension,
    runtimeCodehash: i.extensionRuntimeKeccak,
    production: false,
  })!,
);
const ALL = PINS.map((p) => p.address);

function processorsFor(
  zeroSeedLaunchAddresses: readonly `0x${string}`[],
): EvmLogProcessor[] {
  return createLogProcessorsV3({
    mevCaptureAddress: unused(1),
    boostedFeesConcentratedAddress: unused(2),
    boostedFeesStableswapAddress: unused(3),
    coreAddress: CORE,
    oracleAddress: unused(4),
    incentivesAddress: unused(5),
    tokenWrapperFactoryAddress: unused(6),
    auctionsAddress: unused(7),
    twammAddresses: [],
    ordersAddresses: [],
    positionsContracts: [],
    zeroSeedLaunchAddresses,
  });
}

const filtersOf = (processors: EvmLogProcessor[]): LogStreamFilter[] =>
  processors.map((p, ix) => ({
    id: ix + 1,
    address: p.address,
    topics: p.filter.topics,
    strict: p.filter.strict,
  }));

type Guard = ReturnType<typeof zeroSeedLaunchCatchUpGuard>;

/** The runtime's per-block transaction: drop anything at or above the block, then write it. */
async function applyBlock(
  dao: DAO,
  processors: EvmLogProcessor[],
  block: StreamBlock,
  guard?: Guard,
) {
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
    if (guard) await guard(tx, parsed.header.number);
    await processEvmBlock(processors, parsed.block, parsed.header.number, tx);
  });
}

async function invalidateFrom(dao: DAO, blockNumber: number) {
  await dao.begin((tx) => tx.deleteOldBlockNumbers(blockNumber));
}

type Db = {
  sql: Sql<{ bigint: bigint; numeric: bigint }>;
  dao: DAO;
  name: string;
};

/** Signed 128-bit and 32-bit fields of Core's packed pool state word. */
function decodePoolState(word: `0x${string}`) {
  const n = BigInt(word);
  return {
    sqrtRatio: floatSqrtRatioToFixed(n >> 160n),
    tick: Number(BigInt.asIntN(32, n >> 128n)),
    liquidity: n & ((1n << 128n) - 1n),
  };
}

const num = (hex: string) => BigInt(hex).toString();

describe.skipIf(!SERVER)(
  "zero-seed launch replay of local chain logs on Postgres",
  () => {
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
    }, 60_000);

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
      check?: (
        state: FixtureState,
        block: Branch["blocks"][number],
      ) => Promise<void>,
      guard?: Guard,
    ) {
      const blocks = groupLogsByBlock(branch.logs, filtersOf(processors));
      for (const fixtureBlock of branch.blocks) {
        const block = blocks.find(
          (b) => Number(b.header.blockNumber) === fixtureBlock.number,
        );
        if (block) await applyBlock(db.dao, processors, block, guard);
        const state = branch.states.find(
          (s) => s.blockNumber === fixtureBlock.number,
        )!;
        if (check) await check(state, fixtureBlock);
      }
    }

    // ----- committed-state invariants ---------------------------------------

    async function ledgerRows(db: Db) {
      return db.sql<
        {
          pool_id: bigint;
          accrued0: bigint;
          accrued1: bigint;
          claimed0: bigint;
          claimed1: bigint;
          paid0: bigint;
          paid1: bigint;
          swap_count: bigint;
          claim_count: bigint;
          created_event_id: bigint;
          last_event_id: bigint;
          initial_owner: bigint | null;
          current_owner: bigint | null;
          owner_event_id: bigint | null;
          owner_change_count: bigint;
        }[]
      >`
      SELECT pk.pool_id, s.accrued0, s.accrued1, s.claimed0, s.claimed1, s.paid0, s.paid1, s.swap_count,
             s.claim_count, s.created_event_id, s.last_event_id, s.initial_owner, s.current_owner,
             s.owner_event_id, s.owner_change_count
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
             COALESCE((SELECT SUM(amount0) FROM zero_seed_launch_fees_paid f WHERE f.pool_key_id = c.pool_key_id), 0) AS paid0,
             COALESCE((SELECT SUM(amount1) FROM zero_seed_launch_fees_paid f WHERE f.pool_key_id = c.pool_key_id), 0) AS paid1,
             (SELECT COUNT(*) FROM zero_seed_launch_swapped w WHERE w.pool_key_id = c.pool_key_id)::int8 AS swap_count,
             (SELECT COUNT(*) FROM zero_seed_launch_fees_claimed f WHERE f.pool_key_id = c.pool_key_id)::int8 AS claim_count,
             c.event_id AS created_event_id,
             GREATEST(c.event_id,
                      (SELECT MAX(event_id) FROM zero_seed_launch_swapped w WHERE w.pool_key_id = c.pool_key_id),
                      (SELECT MAX(event_id) FROM zero_seed_launch_fees_claimed f WHERE f.pool_key_id = c.pool_key_id),
                      (SELECT MAX(event_id) FROM zero_seed_launch_fees_paid f WHERE f.pool_key_id = c.pool_key_id),
                      (SELECT MAX(event_id) FROM zero_seed_launch_owner_changed o WHERE o.pool_key_id = c.pool_key_id)) AS last_event_id,
             (SELECT new_owner FROM zero_seed_launch_owner_changed o WHERE o.pool_key_id = c.pool_key_id ORDER BY event_id LIMIT 1) AS initial_owner,
             (SELECT new_owner FROM zero_seed_launch_owner_changed o WHERE o.pool_key_id = c.pool_key_id ORDER BY event_id DESC LIMIT 1) AS current_owner,
             (SELECT MAX(event_id) FROM zero_seed_launch_owner_changed o WHERE o.pool_key_id = c.pool_key_id) AS owner_event_id,
             (SELECT COUNT(*) FROM zero_seed_launch_owner_changed o WHERE o.pool_key_id = c.pool_key_id)::int8 AS owner_change_count
      FROM zero_seed_launch_created c JOIN pool_keys pk USING (pool_key_id)
      ORDER BY pk.pool_id`;
    }

    async function expectLedgerConsistent(db: Db) {
      const rows = await ledgerRows(db);
      expect(rows.map((r) => ({ ...r }))).toEqual(
        (await recomputedLedger(db)).map((r) => ({ ...r })) as never,
      );
      for (const r of rows) {
        for (const v of [r.accrued0, r.accrued1, r.claimed0, r.claimed1])
          expect(v >= 0n).toBe(true);
        expect(r.claimed0 <= r.accrued0 && r.claimed1 <= r.accrued1).toBe(true);
        // every claim here goes through the periphery: the payout equals the
        // ledger movement once, and is never counted on top of it
        expect([r.paid0, r.paid1]).toEqual([r.claimed0, r.claimed1]);
      }
    }

    async function poolRow(db: Db, poolId: `0x${string}`) {
      const [row] = await db.sql<
        {
          sqrt_ratio: bigint;
          tick: number;
          liquidity: bigint;
          accrued0: bigint;
          accrued1: bigint;
          claimed0: bigint;
          claimed1: bigint;
          balance0: bigint;
          balance1: bigint;
          token0: bigint;
          token1: bigint;
          current_owner: bigint | null;
          initial_owner: bigint | null;
          controller: bigint;
          requested_supply: bigint;
          sink_supply: bigint;
          fee_at: bigint;
        }[]
      >`
      SELECT ps.sqrt_ratio, ps.tick, ps.liquidity, s.accrued0, s.accrued1, s.claimed0, s.claimed1,
             pt.balance0, pt.balance1, pk.token0, pk.token1, s.current_owner, s.initial_owner, c.controller,
             c.requested_supply, c.sink_supply,
             zero_seed_launch_model_fee_at(c.fee_model, c.trading_start, c.fee_duration, c.decay_rate_x32,
                                           c.initial_fee, c.final_fee,
                                           (SELECT EXTRACT(EPOCH FROM MAX(block_time))::int8 FROM blocks)) AS fee_at
      FROM pool_keys pk
               JOIN pool_states ps USING (pool_key_id)
               JOIN zero_seed_launch_states s USING (pool_key_id)
               JOIN zero_seed_launch_created c USING (pool_key_id)
               JOIN pool_tvl pt USING (pool_key_id)
      WHERE pk.chain_id = ${CHAIN_ID} AND pk.pool_id = ${num(poolId)}::numeric`;
      return row;
    }

    /** Indexed Core state, fee ledger, owner, fee rate and Core custody equal the chain at this block. */
    async function expectChainParity(db: Db, state: FixtureState) {
      const custody = new Map<bigint, bigint>();
      const add = (token: bigint, amount: bigint) =>
        custody.set(token, (custody.get(token) ?? 0n) + amount);
      for (const pool of state.pools) {
        const row = await poolRow(db, pool.poolId);
        expect(row, `${pool.label} indexed`).toBeDefined();
        expect({
          sqrtRatio: row.sqrt_ratio,
          tick: row.tick,
          liquidity: row.liquidity,
        }).toEqual(decodePoolState(pool.poolStateWord));
        const unclaimed = [
          row.accrued0 - row.claimed0,
          row.accrued1 - row.claimed1,
        ];
        expect(unclaimed.map(String)).toEqual(pool.creatorFees);
        expect([row.current_owner, row.controller]).toEqual([
          BigInt(pool.launchOwner),
          BigInt(pool.controller),
        ]);
        expect(row.initial_owner).toBe(
          BigInt(fixture.installations[pool.label].owner),
        );
        expect(String(row.fee_at)).toBe(pool.feeAtBlockTime);
        // totalSupply is the requested supply; address(0) holds the sink
        expect([String(row.requested_supply), String(row.sink_supply)]).toEqual(
          [pool.totalSupply, pool.sinkBalance],
        );
        // Core holds each pool's reserves (Core events only) plus the
        // extension's saved fee balance; the two ledgers never mix.
        add(row.token0, row.balance0 + unclaimed[0]);
        add(row.token1, row.balance1 + unclaimed[1]);
      }
      const expected = Object.fromEntries(
        Object.entries(state.coreBalances).map(([t, v]) => [
          BigInt(t).toString(),
          v,
        ]),
      );
      expect(
        Object.fromEntries(
          [...custody].map(([t, v]) => [t.toString(), v.toString()]),
        ),
      ).toEqual(expected);
    }

    async function expectPoolLastEventId(db: Db) {
      const rows = await db.sql<{ ok: boolean }[]>`
      SELECT plei.last_event_id = GREATEST(ps.last_event_id, s.created_event_id) AS ok
      FROM zero_seed_launch_states s
               JOIN pool_states ps USING (pool_key_id)
               JOIN pool_last_event_id plei USING (pool_key_id)`;
      const [{ n }] = await db.sql<
        { n: number }[]
      >`SELECT COUNT(*)::int AS n FROM zero_seed_launch_states`;
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
      const q = (text: string) =>
        db.sql.unsafe(text).then((rows) => rows.map((r) => ({ ...r })));
      return {
        blocks: await q(
          `SELECT block_number, block_hash, block_time, num_events FROM blocks ORDER BY block_number`,
        ),
        created: await q(
          `SELECT c.*, NULL AS pool_key_id FROM zero_seed_launch_created c ORDER BY event_id`,
        ),
        swapped: await q(
          `SELECT w.*, NULL AS pool_key_id FROM zero_seed_launch_swapped w ORDER BY event_id`,
        ),
        claimed: await q(
          `SELECT f.*, NULL AS pool_key_id FROM zero_seed_launch_fees_claimed f ORDER BY event_id`,
        ),
        owners: await q(
          `SELECT o.*, NULL AS pool_key_id FROM zero_seed_launch_owner_changed o ORDER BY event_id`,
        ),
        paid: await q(
          `SELECT p.*, NULL AS pool_key_id FROM zero_seed_launch_fees_paid p ORDER BY event_id`,
        ),
        states: await ledgerRows(db).then((rows) =>
          rows.map((r) => ({ ...r })),
        ),
        pools:
          await q(`SELECT pk.pool_id, ps.sqrt_ratio, ps.tick, ps.liquidity, ps.last_event_id, plei.last_event_id AS plei, pt.balance0, pt.balance1
                      FROM pool_keys pk JOIN pool_states ps USING (pool_key_id) JOIN pool_last_event_id plei USING (pool_key_id)
                      JOIN pool_tvl pt USING (pool_key_id) ORDER BY pk.pool_id`),
        view: await q(`SELECT pool_id, sqrt_ratio, tick, liquidity, last_event_id, ticks, zero_seed_launch_token_is_token1,
                       zero_seed_launch_tick_lower, zero_seed_launch_tick_upper, zero_seed_launch_liquidity,
                       zero_seed_launch_trading_start, zero_seed_launch_fee_model, zero_seed_launch_fee_duration,
                       zero_seed_launch_decay_rate_x32, zero_seed_launch_initial_fee,
                       zero_seed_launch_final_fee, is_zero_seed_launch_pool
                     FROM all_pool_states_view v JOIN pool_keys USING (pool_key_id) ORDER BY pool_id`),
      };
    }

    const LAUNCH_ON = () => processorsFor(ALL);

    async function canonicalReplay() {
      const db = await freshDb();
      await replay(db, prefix, LAUNCH_ON());
      await replay(db, canonical, LAUNCH_ON());
      return db;
    }

    // ----- scenarios ---------------------------------------------------------

    let canonicalDump: Awaited<ReturnType<typeof dump>>;

    test("the single fixture instance resolves through the pins and serves both quote kinds", () => {
      expect(PINS.map((p) => [p.address, p.deploymentBlock])).toEqual([
        [fixture.instances[0].extension.toLowerCase() as Hex, 2],
      ]);
      expect(
        new Set(Object.values(fixture.launches).map((l) => l.quoteKind)),
      ).toEqual(new Set(["native", "erc20"]));
    });

    test("canonical replay equals chain state after every block", async () => {
      const db = await freshDb();
      const processors = LAUNCH_ON();
      await replay(db, prefix, processors, (state) => check(db, state));
      await replay(db, canonical, processors, (state) => check(db, state));
      canonicalDump = await dump(db);
      expect(canonicalDump.created.length).toBe(7);
      expect(canonicalDump.swapped.length).toBeGreaterThan(15);
      expect(canonicalDump.claimed.length).toBe(8);
      expect(canonicalDump.paid.length).toBe(8);
      // seven creations and three transfers
      expect(canonicalDump.owners.length).toBe(10);
      const quotes = canonicalDump.created.map((c) => [
        String(c.quote_token),
        c.quote_kind,
        c.token_is_token1,
      ]);
      expect(quotes).toEqual([
        ["0", "native", true],
        [BigInt(fixture.launches.l2.quote).toString(), "erc20", false],
        [BigInt(fixture.launches.l4.quote).toString(), "erc20", false],
        ["0", "native", true],
        [BigInt(fixture.launches.l6.quote).toString(), "erc20", false],
        [BigInt(fixture.launches.l7.quote).toString(), "erc20", false],
        [BigInt(fixture.launches.l8.quote).toString(), "erc20", false],
      ]);
      // one extension for every quote
      expect(
        new Set(canonicalDump.created.map((c) => String(c.emitter))),
      ).toEqual(new Set([BigInt(PINS[0].address).toString()]));
      await db.sql.end();
    }, 120_000);

    test("supply: requested, installed and sink are stored exactly, and installed is Core's position delta", async () => {
      const db = await canonicalReplay();
      const rows = await db.sql<
        {
          pool_id: bigint;
          requested_supply: bigint;
          installed_supply: bigint;
          sink_supply: bigint;
          liquidity: bigint;
          core_installed: bigint;
          core_quote: bigint;
          core_liquidity: bigint;
        }[]
      >`
      SELECT c.pool_id, c.requested_supply, c.installed_supply, c.sink_supply, c.liquidity,
             CASE WHEN c.token_is_token1 THEN p.delta1 ELSE p.delta0 END AS core_installed,
             CASE WHEN c.token_is_token1 THEN p.delta0 ELSE p.delta1 END AS core_quote,
             p.liquidity_delta AS core_liquidity
      FROM zero_seed_launch_created c
               JOIN position_updates p ON p.chain_id = c.chain_id AND p.pool_key_id = c.pool_key_id
                                          AND p.transaction_hash = c.transaction_hash
      ORDER BY c.event_id`;
      expect(rows.map((r) => ({ ...r }))).toEqual(
        ["l1", "l2", "l4", "l5", "l6", "l7", "l8"].map((label) => {
          const l = fixture.launches[label];
          return {
            pool_id: BigInt(l.poolId),
            requested_supply: BigInt(l.requestedSupply),
            installed_supply: BigInt(l.installedSupply),
            sink_supply: BigInt(l.sinkSupply),
            liquidity: BigInt(l.liquidity),
            core_installed: BigInt(l.installedSupply),
            core_quote: 0n,
            core_liquidity: BigInt(l.liquidity),
          };
        }),
      );
      for (const r of rows)
        expect(r.sink_supply).toBe(r.requested_supply - r.installed_supply);
      // Requested supply is stored as submitted, also for the two low-price
      // token0 launches; l8 installs its whole int128-scale supply (no sink).
      expect(rows.map((r) => [r.requested_supply, r.sink_supply > 0n])).toEqual(
        [
          ...Array.from({ length: 5 }, () => [10n ** 27n, true]),
          [10n ** 30n, true],
          [170141183460469231694794709727778658247n, false],
        ],
      );
      // The table refuses an installed supply above the request, or zero.
      for (const installed of ["0", "1000000000000000000000000001"])
        await expectRejects(
          db.sql.begin((tx) =>
            tx.unsafe(
              `INSERT INTO zero_seed_launch_created
                 (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
                  pool_key_id, pool_id, token, controller, quote_token, position_id, liquidity, requested_supply,
                  installed_supply, name, symbol, decimals, ask_tick, upper_tick, tick_spacing, trading_start,
                  fee_model, fee_duration, decay_rate_x32, initial_fee, final_fee, salt)
                 SELECT chain_id, block_number, transaction_index, event_index + 1000, transaction_hash, emitter,
                        NULL, pool_id, token, controller, quote_token, position_id, liquidity, requested_supply,
                        ${installed}, name, symbol, decimals, ask_tick, upper_tick, tick_spacing, trading_start,
                        fee_model, fee_duration, decay_rate_x32, initial_fee, final_fee, salt
                 FROM zero_seed_launch_created LIMIT 1`,
            ),
          ),
          /check constraint/,
        );
      await db.sql.end();
    }, 120_000);

    test("LaunchCreated is refused without exactly one consistent Core position update of the launch", async () => {
      const blocks = groupLogsByBlock(prefix.logs, filtersOf(LAUNCH_ON()));
      // l2: the ERC-20 quote launch, alone in its block's first transaction
      const l2 = fixture.launches.l2;
      const createdIn = blocks.find((b) =>
        b.logs.some(
          (l) => l.topics[0] === LAUNCH_CREATED && l.topics[1] === l2.poolId,
        ),
      )!;
      const createdNumber = Number(createdIn.header.blockNumber);
      const positionEvent = CORE_ABI.find(
        (i) => i.type === "event" && i.name === "PositionUpdated",
      ) as AbiEvent;
      const positionTopic = encodeEventTopics({ abi: [positionEvent] })[0];
      const isLaunchPosition = (l: StreamLog) =>
        l.topics[0] === positionTopic &&
        decodeArgs<{ poolId: Hex }>(CORE_ABI, "PositionUpdated", l).poolId ===
          l2.poolId;
      expect(createdIn.logs.filter(isLaunchPosition)).toHaveLength(1);
      type Position = {
        locker: Hex;
        poolId: Hex;
        positionId: Hex;
        liquidityDelta: bigint;
        balanceUpdate: Hex;
        stateAfter: Hex;
      };
      const rewrite = (change: (p: Position) => Position | undefined) => ({
        ...createdIn,
        logs: createdIn.logs.flatMap((l) => {
          if (!isLaunchPosition(l)) return [l];
          const changed = change(
            decodeArgs<Position>(CORE_ABI, "PositionUpdated", l),
          );
          if (!changed) return [];
          return [
            {
              ...l,
              data: encodeAbiParameters(positionEvent.inputs, [
                changed.locker,
                changed.poolId,
                changed.positionId,
                changed.liquidityDelta,
                changed.balanceUpdate,
                changed.stateAfter,
              ]),
            },
          ];
        }),
      });
      const word = (hi: bigint, lo: bigint) =>
        `0x${BigInt.asUintN(128, hi).toString(16).padStart(32, "0")}${BigInt.asUintN(128, lo).toString(16).padStart(32, "0")}` as Hex;
      const installed = BigInt(l2.installedSupply);
      // l2's launch token is token0: the installed supply is delta0
      const cases: [string, (p: Position) => Position | undefined, RegExp][] = [
        ["missing", () => undefined, /0 Core position updates/],
        [
          "another locker",
          (p) => ({ ...p, locker: unused(77) }),
          /0 Core position updates/,
        ],
        [
          "another position",
          (p) => ({
            ...p,
            positionId: `0x${(BigInt(p.positionId) | (1n << 64n)).toString(16).padStart(64, "0")}`,
          }),
          /0 Core position updates/,
        ],
        [
          "another liquidity",
          (p) => ({ ...p, liquidityDelta: p.liquidityDelta - 1n }),
          /liquidity delta != LaunchCreated.liquidity/,
        ],
        [
          "quote taken",
          (p) => ({ ...p, balanceUpdate: word(installed, 1n) }),
          /Core took quote/,
        ],
        [
          "no launch token",
          (p) => ({ ...p, balanceUpdate: word(0n, 0n) }),
          /installed supply is outside/,
        ],
        [
          "above the request",
          (p) => ({
            ...p,
            balanceUpdate: word(BigInt(l2.requestedSupply) + 1n, 0n),
          }),
          /installed supply is outside/,
        ],
      ];
      const db = await freshDb();
      const processors = LAUNCH_ON();
      await replay(
        db,
        {
          ...prefix,
          blocks: prefix.blocks.filter((b) => b.number < createdNumber),
        },
        processors,
      );
      const before = await dump(db);
      for (const [name, change, error] of cases) {
        await expectRejects(
          applyBlock(db.dao, processors, rewrite(change)),
          error,
        );
        expect(await dump(db), name).toEqual(before);
      }
      // the unmodified block is accepted
      await applyBlock(db.dao, processors, createdIn);
      const [row] = await db.sql<{ installed_supply: bigint }[]>`
        SELECT installed_supply FROM zero_seed_launch_created WHERE pool_id = ${num(l2.poolId)}::numeric`;
      expect(row.installed_supply).toBe(installed);
      // A LaunchCreated delivered before its Core position update (a log
      // order the chain never produces) finds none and is refused.
      const createdLog = createdIn.logs.find(
        (l) => l.topics[0] === LAUNCH_CREATED,
      )!;
      const event = decodeArgs<{
        poolId: Hex;
        token: Hex;
        controller: Hex;
        positionId: Hex;
        liquidity: bigint;
        parameters: {
          supply: bigint;
          quoteToken: Hex;
          name: string;
          symbol: string;
          decimals: number;
          askTick: number;
          upperTick: number;
          tickSpacing: number;
          tradingStart: bigint;
          feeDuration: number;
          initialFee: bigint;
          finalFee: bigint;
          salt: Hex;
        };
      }>(ZERO_SEED_LAUNCH_ABI, "LaunchCreated", createdLog);
      const position = createdIn.logs.find(isLaunchPosition)!;
      await expectRejects(
        db.dao.begin((tx) =>
          tx.insertZeroSeedLaunchCreatedEvent(
            {
              blockNumber: createdNumber,
              transactionIndex: position.transactionIndex,
              eventIndex: position.logIndex,
              emitter: createdLog.address,
              transactionHash: createdLog.transactionHash,
            },
            {
              coreAddress: CORE,
              ...event,
              ...event.parameters,
              feeModel: "fixed_base_duration_v1",
              tradingStart: event.parameters.tradingStart,
              quoteToken: event.parameters.quoteToken,
              requestedSupply: event.parameters.supply,
            },
          ),
        ),
        /0 Core position updates/,
      );
      await db.sql.end();
    }, 120_000);

    test("ownership: creator from the creation transfer, current owner from the latest, payouts only by the current owner", async () => {
      const db = await canonicalReplay();
      const rows = await db.sql<
        {
          pool_id: bigint;
          initial_owner: bigint;
          current_owner: bigint;
          owner_change_count: bigint;
        }[]
      >`
      SELECT pk.pool_id, s.initial_owner, s.current_owner, s.owner_change_count
      FROM zero_seed_launch_states s JOIN pool_keys pk USING (pool_key_id) ORDER BY s.created_event_id`;
      const { creator, newOwner, feeRecipient, trader } = fixture.addresses;
      expect(
        rows.map((r) => [
          r.initial_owner,
          r.current_owner,
          Number(r.owner_change_count),
        ]),
      ).toEqual([
        [BigInt(creator), BigInt(feeRecipient), 3], // l1: creator -> new -> recipient
        [BigInt(creator), BigInt(newOwner), 2], // l2: creator -> new
        [BigInt(trader), BigInt(trader), 1], // l4
        [BigInt(creator), BigInt(creator), 1], // l5
        [BigInt(trader), BigInt(trader), 1], // l6
        [BigInt(creator), BigInt(creator), 1], // l7
        [BigInt(trader), BigInt(trader), 1], // l8
      ]);
      // The creation transfer comes from zero right after LaunchCreated, in the same transaction.
      const [{ ok }] = await db.sql<{ ok: boolean }[]>`
      SELECT bool_and(o.previous_owner = 0 AND o.transaction_hash = c.transaction_hash AND o.event_id > c.event_id) AS ok
      FROM zero_seed_launch_created c
               JOIN LATERAL (SELECT * FROM zero_seed_launch_owner_changed o
                             WHERE o.pool_key_id = c.pool_key_id ORDER BY event_id LIMIT 1) o ON TRUE`;
      expect(ok).toBe(true);
      // Every payout names the owner at that time and links its own extension claim.
      const payouts = await db.sql<{ ok: boolean }[]>`
      SELECT p.owner = (SELECT new_owner FROM zero_seed_launch_owner_changed o
                        WHERE o.pool_key_id = p.pool_key_id AND o.event_id < p.event_id
                        ORDER BY o.event_id DESC LIMIT 1)
               AND f.transaction_hash = p.transaction_hash AND f.event_id < p.event_id
               AND (f.amount0, f.amount1) = (p.amount0, p.amount1) AND f.controller = p.emitter AS ok
      FROM zero_seed_launch_fees_paid p
               JOIN zero_seed_launch_fees_claimed f ON f.chain_id = p.chain_id AND f.event_id = p.claimed_event_id`;
      expect(payouts.length).toBe(8);
      expect(payouts.every((r) => r.ok)).toBe(true);
      await db.sql.end();
    }, 120_000);

    test("DAO refuses foreign owners, sink recipients, unmatched payouts and another controller, leaving committed state unchanged", async () => {
      const db = await canonicalReplay();
      const logOf = (topic0: `0x${string}`) =>
        canonical.logs.find((l) => l.topics[0] === topic0)!;
      const keyOf = (log: RawLog) => ({
        blockNumber: Number(log.blockNumber),
        transactionIndex: Number(log.transactionIndex),
        eventIndex: Number(log.logIndex),
        emitter: log.address,
        transactionHash: log.transactionHash,
      });
      const paidLog = logOf(FEES_PAID);
      const paid = decodeArgs<{
        poolId: Hex;
        owner: Hex;
        recipient: Hex;
        amount0: bigint;
        amount1: bigint;
      }>(ZERO_SEED_LAUNCH_PERIPHERY_ABI, "LaunchFeesClaimed", paidLog);
      const launch = Object.values(fixture.launches).find(
        (l) => l.poolId === paid.poolId,
      )!;
      const base = {
        coreAddress: CORE,
        extension: launch.extension,
        ...paid,
      };
      // A fresh event position in the same block: not a redelivery.
      const freshKey = { ...keyOf(paidLog), eventIndex: 999 };
      const before = await dump(db);
      for (const recipient of [
        unused(0),
        CORE,
        launch.extension,
        launch.periphery,
        launch.token,
        launch.quote,
      ]) {
        await expectRejects(
          db.dao.begin((tx) =>
            tx.insertZeroSeedLaunchFeesPaidEvent(freshKey, {
              ...base,
              recipient: recipient as `0x${string}`,
            }),
          ),
          /sink recipient/,
        );
      }
      await expectRejects(
        db.dao.begin((tx) =>
          tx.insertZeroSeedLaunchFeesPaidEvent(freshKey, {
            ...base,
            owner: unused(99),
          }),
        ),
        /another owner/,
      );
      // the same payout again at another position has no unlinked claim left
      await expectRejects(
        db.dao.begin((tx) =>
          tx.insertZeroSeedLaunchFeesPaidEvent(freshKey, base),
        ),
        /without its extension claim/,
      );
      // an owner change not from the current owner, to zero, or from a non-controller
      const ownerLog = logOf(OWNER_CHANGED);
      const owner = decodeArgs<{
        poolId: Hex;
        previousOwner: Hex;
        newOwner: Hex;
      }>(ZERO_SEED_LAUNCH_PERIPHERY_ABI, "LaunchOwnerChanged", ownerLog);
      const ownerLaunch = Object.values(fixture.launches).find(
        (l) => l.poolId === owner.poolId,
      )!;
      const ownerKey = { ...keyOf(ownerLog), eventIndex: 999 };
      for (const [key, change] of [
        [ownerKey, { previousOwner: unused(98), newOwner: unused(97) }],
        [ownerKey, { previousOwner: unused(0), newOwner: unused(97) }],
        [
          { ...ownerKey, emitter: unused(96) },
          { previousOwner: owner.newOwner, newOwner: unused(97) },
        ],
      ] as const)
        await expectRejects(
          db.dao.begin((tx) =>
            tx.insertZeroSeedLaunchOwnerChangedEvent(key, {
              coreAddress: CORE,
              extension: ownerLaunch.extension,
              poolId: owner.poolId,
              ...change,
            }),
          ),
          /Refusing LaunchOwnerChanged/,
        );
      // an extension claim by a controller other than the launch's
      const claimLog = logOf(CREATOR_FEES_CLAIMED);
      const claim = decodeArgs<{
        poolId: Hex;
        controller: Hex;
        amount0: bigint;
        amount1: bigint;
      }>(ZERO_SEED_LAUNCH_ABI, "CreatorFeesClaimed", claimLog);
      await expectRejects(
        db.dao.begin((tx) =>
          tx.insertZeroSeedLaunchFeesClaimedEvent(
            { ...keyOf(claimLog), eventIndex: 999 },
            { coreAddress: CORE, ...claim, controller: unused(95) },
          ),
        ),
        /another controller/,
      );
      // a periphery event attributed to an extension that is not the pool's
      await expectRejects(
        db.dao.begin((tx) =>
          tx.insertZeroSeedLaunchFeesPaidEvent(freshKey, {
            ...base,
            extension: unused(94),
          }),
        ),
        /not a registered launch pool/,
      );
      expect(await dump(db)).toEqual(before);
      // Valid redelivery of each stored periphery log is an idempotent retry.
      await db.dao.begin(async (tx) => {
        await tx.insertZeroSeedLaunchFeesPaidEvent(keyOf(paidLog), base);
        await tx.insertZeroSeedLaunchOwnerChangedEvent(keyOf(ownerLog), {
          coreAddress: CORE,
          extension: ownerLaunch.extension,
          ...owner,
        });
      });
      expect(await dump(db)).toEqual(before);
      await db.sql.end();
    }, 120_000);

    test("every swap: fee rate is feeAt at the block, and launch delta = Core delta + fee on one side", async () => {
      const db = await canonicalReplay();
      const rows = await db.sql<
        {
          ok_rate: boolean;
          ok_fee_side: boolean;
          ok_other: boolean;
          core_found: boolean;
          zero_fill: boolean;
          native: boolean;
        }[]
      >`
      SELECT w.fee_rate = zero_seed_launch_model_fee_at(c.fee_model, c.trading_start, c.fee_duration,
                                                         c.decay_rate_x32, c.initial_fee, c.final_fee,
                                                         EXTRACT(EPOCH FROM b.block_time)::int8) AS ok_rate,
             (CASE WHEN w.fee_is_token1 THEN w.delta1 - s.delta1 ELSE w.delta0 - s.delta0 END) = w.fee_amount AS ok_fee_side,
             (CASE WHEN w.fee_is_token1 THEN w.delta0 = s.delta0 ELSE w.delta1 = s.delta1 END) AS ok_other,
             s.event_id IS NOT NULL AS core_found,
             w.delta0 = 0 AND w.delta1 = 0 AND w.fee_amount = 0 AS zero_fill,
             c.quote_kind = 'native' AS native
      FROM zero_seed_launch_swapped w
               JOIN zero_seed_launch_created c USING (pool_key_id)
               JOIN blocks b ON b.chain_id = w.chain_id AND b.block_number = w.block_number
               LEFT JOIN LATERAL (SELECT * FROM swaps s
                                  WHERE s.chain_id = w.chain_id AND s.pool_key_id = w.pool_key_id
                                    AND s.transaction_hash = w.transaction_hash AND s.event_id < w.event_id
                                  ORDER BY s.event_id DESC LIMIT 1) s ON TRUE`;
      expect(rows.length).toBeGreaterThan(15);
      expect(rows.some((r) => r.native) && rows.some((r) => !r.native)).toBe(
        true,
      );
      // A zero fill (the two deliberate no-bid sells) moves nothing, and Core
      // emits no swap log for it; every other launch swap has its Core swap.
      expect(rows.filter((r) => r.zero_fill).map((r) => r.core_found)).toEqual([
        false,
        false,
      ]);
      expect(
        rows.filter(
          (r) =>
            !r.zero_fill &&
            !(r.core_found && r.ok_rate && r.ok_fee_side && r.ok_other),
        ),
      ).toEqual([]);
      await db.sql.end();
    }, 120_000);

    test("the maximum rate 2^64 - 1 is stored and served exactly: schedule, swaps and fee_at", async () => {
      const db = await canonicalReplay();
      const MAX = 2n ** 64n - 1n;
      const created = await db.sql<
        {
          pool_id: bigint;
          initial_fee: string;
          final_fee: string;
          fee_duration: bigint;
        }[]
      >`
      SELECT pool_id, initial_fee::TEXT, final_fee::TEXT, fee_duration
      FROM zero_seed_launch_created WHERE initial_fee = ${MAX.toString()}::NUMERIC ORDER BY event_id`;
      expect(
        created.map((r) => [
          r.pool_id,
          r.initial_fee,
          r.final_fee,
          Number(r.fee_duration),
        ]),
      ).toEqual([
        [
          BigInt(fixture.launches.l5.poolId),
          MAX.toString(),
          "55340232221128654",
          3600,
        ],
        [BigInt(fixture.launches.l6.poolId), MAX.toString(), MAX.toString(), 1],
      ]);
      // Exact input nets floor(gross / 2^64); exact output pays calculated * 2^64.
      const swaps = await db.sql<
        { fee_rate: string; calculated: string; fee_amount: string }[]
      >`
      SELECT w.fee_rate::TEXT,
             (CASE WHEN w.fee_is_token1 THEN w.delta1 ELSE w.delta0 END)::TEXT AS calculated,
             w.fee_amount::TEXT
      FROM zero_seed_launch_swapped w JOIN zero_seed_launch_created c USING (pool_key_id)
      WHERE c.initial_fee = ${MAX.toString()}::NUMERIC ORDER BY w.event_id`;
      const atMax = swaps.filter((r) => r.fee_rate === MAX.toString());
      expect(atMax).toHaveLength(4);
      for (const r of atMax) {
        const calculated = BigInt(r.calculated);
        const fee = BigInt(r.fee_amount);
        if (calculated < 0n)
          expect(-calculated).toBe((fee - calculated) / 2n ** 64n);
        else
          expect([calculated % 2n ** 64n, fee]).toEqual([
            0n,
            (calculated / 2n ** 64n) * MAX,
          ]);
      }
      // fee_at at the maximum: exact endpoints, never 2^64, monotone over the window.
      const [ends] = await db.sql<
        {
          start: string;
          end: string;
          flat: string;
          above: boolean;
          rising: number;
        }[]
      >`
      SELECT zero_seed_launch_fee_at(0, 3600, ${MAX.toString()}::NUMERIC, 55340232221128654, 0)::TEXT AS start,
             zero_seed_launch_fee_at(0, 3600, ${MAX.toString()}::NUMERIC, 55340232221128654, 3600)::TEXT AS end,
             zero_seed_launch_fee_at(0, 1, ${MAX.toString()}::NUMERIC, ${MAX.toString()}::NUMERIC, 1)::TEXT AS flat,
             EXISTS (SELECT 1 FROM generate_series(0, 3600) t
                     WHERE zero_seed_launch_fee_at(0, 3600, ${MAX.toString()}::NUMERIC, 0, t) > ${MAX.toString()}::NUMERIC) AS above,
             (SELECT COUNT(*)::int FROM generate_series(1, 3600) t
              WHERE zero_seed_launch_fee_at(0, 3600, ${MAX.toString()}::NUMERIC, 0, t)
                  > zero_seed_launch_fee_at(0, 3600, ${MAX.toString()}::NUMERIC, 0, t - 1)) AS rising`;
      expect(ends).toEqual({
        start: MAX.toString(),
        end: "55340232221128654",
        flat: MAX.toString(),
        above: false,
        rising: 0,
      });
      await db.sql.end();
    }, 120_000);

    test("fee_at and decay_q128 reproduce the independent all-second vectors bit for bit", async () => {
      const db = await freshDb();
      // [initial, final, duration, elapsed, fee] for every second of 12 curves,
      // from the protocol's 250-digit Decimal generator, not from this code.
      const rows = JSON.parse(
        gunzipSync(
          readFileSync(
            resolve(
              ROOT,
              "tests/fixtures/zero-seed-launch/fee-curve-all-seconds.json.gz",
            ),
          ),
        ).toString("utf8"),
      ) as [string, string, string, string, string][];
      expect(rows.length).toBe(25_212);
      const mismatches = await db.sql<{ n: number }[]>`
        WITH v AS (
          SELECT (r ->> 0)::numeric AS initial, (r ->> 1)::numeric AS final, (r ->> 2)::int8 AS duration,
                 (r ->> 3)::int8 AS elapsed, (r ->> 4)::numeric AS fee
          FROM jsonb_array_elements((${JSON.stringify(rows)}::text)::jsonb) r
        )
        SELECT COUNT(*) FILTER (WHERE zero_seed_launch_fee_at(1000, duration, initial, final, 1000 + elapsed) <> fee)::int AS n,
               COUNT(*)::int AS total
        FROM v`;
      expect(mismatches[0]).toEqual({ n: 0, total: 25_212 } as never);
      // Before the start the fee is initial.
      const [{ before }] = await db.sql<{ before: bigint }[]>`
        SELECT zero_seed_launch_fee_at(1000, 600, 9223372036854775808, 55340232221128654, 1) AS before`;
      expect(before).toBe(9223372036854775808n);
      const vectors = JSON.parse(
        readFileSync(
          resolve(
            ROOT,
            "tests/fixtures/zero-seed-launch/fee-decay-vectors.json",
          ),
          "utf8",
        ),
      ) as {
        zero_at_or_above: number;
        decay_samples: { t: number; decay_q128: string }[];
        fee_rows: {
          initial: string;
          final: string;
          duration: number;
          elapsed: number;
          fee: string;
        }[];
      };
      for (const { t, decay_q128 } of vectors.decay_samples) {
        const [{ d }] = await db.sql<{ d: bigint }[]>`
          SELECT zero_seed_launch_decay_q128(${t}::int8) AS d`;
        expect(String(d)).toBe(decay_q128);
      }
      for (const t of [vectors.zero_at_or_above - 1, vectors.zero_at_or_above])
        await db.sql`SELECT zero_seed_launch_decay_q128(${t}::int8)`;
      const [{ zero }] = await db.sql<{ zero: bigint }[]>`
        SELECT zero_seed_launch_decay_q128(${vectors.zero_at_or_above}::int8) AS zero`;
      expect(zero).toBe(0n);
      for (const r of vectors.fee_rows) {
        const [{ fee }] = await db.sql<{ fee: bigint }[]>`
          SELECT zero_seed_launch_fee_at(0, ${r.duration}::int8, ${r.initial}::numeric, ${r.final}::numeric,
                                         ${r.elapsed}::int8) AS fee`;
        expect(String(fee)).toBe(r.fee);
      }
      await db.sql.end();
    }, 300_000);

    test("orders: generated pool ticks, view columns and the two tick entries for native token1 and ERC-20 token0 launches", async () => {
      const db = await canonicalReplay();
      const rows = await db.sql<
        { token_is_token1: boolean; native: boolean; ok: boolean }[]
      >`
      SELECT c.token_is_token1,
             c.quote_kind = 'native' AND c.quote_token = 0 AND pk.token0 = 0 AS native,
             v.is_zero_seed_launch_pool
               AND v.zero_seed_launch_tick_lower = c.tick_lower AND v.zero_seed_launch_tick_upper = c.tick_upper
               AND v.zero_seed_launch_liquidity = c.liquidity AND v.zero_seed_launch_token_is_token1 = c.token_is_token1
               AND v.zero_seed_launch_trading_start = c.trading_start AND v.zero_seed_launch_fee_duration = c.fee_duration
               AND v.zero_seed_launch_fee_model = c.fee_model AND v.zero_seed_launch_decay_rate_x32 IS NULL
               AND v.zero_seed_launch_initial_fee = c.initial_fee AND v.zero_seed_launch_final_fee = c.final_fee
               AND v.ticks = JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT('t', c.tick_lower, 'd', c.liquidity::TEXT),
                                               JSONB_BUILD_OBJECT('t', c.tick_upper, 'd', (-c.liquidity)::TEXT))
               AND DIV(c.position_id, 18446744073709551616) = 0
               AND MOD(DIV(c.position_id, 4294967296), 4294967296) = MOD(c.tick_lower::int8 + 4294967296, 4294967296)
               AND MOD(c.position_id, 4294967296) = MOD(c.tick_upper::int8 + 4294967296, 4294967296) AS ok
      FROM zero_seed_launch_created c JOIN all_pool_states_view v USING (pool_key_id) JOIN pool_keys pk USING (pool_key_id)
      ORDER BY c.event_id`;
      expect(rows.map((r) => [r.token_is_token1, r.native])).toEqual([
        [true, true], // l1: native quote, launch token1
        [false, false], // l2: ERC-20 quote, launch token0
        [false, false], // l4
        [true, true], // l5
        [false, false], // l6
        [false, false], // l7: low price, exact token0 installation
        [false, false], // l8: full width at spacing 1, no sink
      ]);
      expect(rows.every((r) => r.ok)).toBe(true);
      await db.sql.end();
    }, 120_000);

    test("deployment-block-inclusive catch-up: a start after the deployment block is refused unless nothing was missed", async () => {
      const deployment = PINS[0].deploymentBlock;
      const deploymentBlock = prefix.blocks.find(
        (b) => b.number === deployment,
      )!;
      expect(deploymentBlock.actions).toContain("create l1");
      const guard = () => zeroSeedLaunchCatchUpGuard(PINS);

      // (1) Inclusive from genesis through the guard: identical to the canonical replay.
      const inclusive = await freshDb();
      await replay(inclusive, prefix, LAUNCH_ON(), undefined, guard());
      await replay(inclusive, canonical, LAUNCH_ON(), undefined, guard());
      expect(await dump(inclusive)).toEqual(canonicalDump);
      await inclusive.sql.end();

      // (2) Support was off through the deployment block, then turned on: refused,
      // because l1's pool was initialized while launches were not indexed.
      const late = await freshDb();
      const upTo = (b: Branch, last: number) => ({
        ...b,
        blocks: b.blocks.filter((x) => x.number <= last),
      });
      const from = (b: Branch, first: number) => ({
        ...b,
        blocks: b.blocks.filter((x) => x.number >= first),
      });
      await replay(late, upTo(prefix, deployment), processorsFor([]));
      await expectRejects(
        replay(
          late,
          from(prefix, deployment + 1),
          LAUNCH_ON(),
          undefined,
          guard(),
        ),
        /launch pools initialized while launch support was off; roll the indexer back to block 1/,
      );
      // Recovery: roll back to the block before the deployment and replay inclusively.
      await invalidateFrom(late.dao, deployment);
      await replay(
        late,
        from(prefix, deployment),
        LAUNCH_ON(),
        undefined,
        guard(),
      );
      await replay(late, canonical, LAUNCH_ON(), undefined, guard());
      expect(await dump(late)).toEqual(canonicalDump);
      await late.sql.end();

      // (3) A database that never indexed the deployment block: refused.
      const skipped = await freshDb();
      await expectRejects(
        replay(
          skipped,
          from(prefix, deployment + 1),
          LAUNCH_ON(),
          undefined,
          guard(),
        ),
        /without this database having indexed the deployment/,
      );
      // Without the guard, starting one block late loses l1's creation: the
      // worker indexes l2 and then stops at l1's first swap.
      await expectRejects(
        replay(skipped, from(prefix, deployment + 1), LAUNCH_ON()),
        /not a registered launch pool/,
      );
      const [{ n }] = await skipped.sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM zero_seed_launch_created`;
      expect(n).toBe(1);
      await skipped.sql.end();

      // (4) Support was on through the deployment block and the guard first
      // runs one block later (a restart): nothing can have been missed (the
      // ExtensionRegistered is indexed and no pool of the extension lacks
      // registration), so the guard accepts and the result equals the
      // canonical replay.
      const db = await freshDb();
      await replay(db, upTo(prefix, deployment), LAUNCH_ON());
      await replay(
        db,
        from(prefix, deployment + 1),
        LAUNCH_ON(),
        undefined,
        guard(),
      );
      await replay(db, canonical, LAUNCH_ON(), undefined, guard());
      expect(await dump(db)).toEqual(canonicalDump);
      await db.sql.end();
    }, 300_000);

    test("reorg: an alternate fork with other transfers, claims and a creation, then the canonical branch, equals a straight replay", async () => {
      const db = await freshDb();
      const processors = LAUNCH_ON();
      await replay(db, prefix, processors);
      await replay(db, alternate, processors, (state) => check(db, state));
      // On the alternate fork l1 moved to the new owner, who claimed; l3 existed.
      const [{ l3, l1Owner }] = await db.sql<{ l3: number; l1Owner: bigint }[]>`
      SELECT (SELECT COUNT(*)::int FROM zero_seed_launch_created WHERE pool_id = ${num(fixture.launches.l3.poolId)}::numeric) AS l3,
             (SELECT s.current_owner FROM zero_seed_launch_states s JOIN pool_keys pk USING (pool_key_id)
              WHERE pk.pool_id = ${num(fixture.launches.l1.poolId)}::numeric) AS "l1Owner"`;
      expect([l3, l1Owner]).toEqual([1, BigInt(fixture.addresses.newOwner)]);
      await invalidateFrom(db.dao, fixture.forkPoint + 1);
      await expectLedgerConsistent(db);
      // the reorg restores the owner of the fork point
      await check(db, prefix.states.at(-1)!);
      await replay(db, canonical, processors, (state) => check(db, state));
      expect(await dump(db)).toEqual(canonicalDump);
      // l3's pool key outlives the fork, as every Core pool key does, but it has
      // no state, no launch row and is not in the view.
      const [{ visible }] = await db.sql<{ visible: number }[]>`
      SELECT COUNT(*)::int AS visible FROM all_pool_states_view v JOIN pool_keys pk USING (pool_key_id)
      WHERE pk.pool_id = ${num(fixture.launches.l3.poolId)}::numeric`;
      expect(visible).toBe(0);
      await db.sql.end();
    }, 120_000);

    test("reorg from the deployment block empties every launch table, and replay restores it", async () => {
      const db = await canonicalReplay();
      const deployment = PINS[0].deploymentBlock;
      await invalidateFrom(db.dao, deployment);
      const [{ n }] = await db.sql<{ n: number }[]>`
      SELECT ((SELECT COUNT(*) FROM zero_seed_launch_created) + (SELECT COUNT(*) FROM zero_seed_launch_swapped)
           + (SELECT COUNT(*) FROM zero_seed_launch_fees_claimed) + (SELECT COUNT(*) FROM zero_seed_launch_states)
           + (SELECT COUNT(*) FROM zero_seed_launch_owner_changed) + (SELECT COUNT(*) FROM zero_seed_launch_fees_paid))::int AS n`;
      expect(n).toBe(0);
      const [{ flagged }] = await db.sql<{ flagged: number }[]>`
      SELECT COUNT(*)::int AS flagged FROM all_pool_states_view WHERE is_zero_seed_launch_pool`;
      expect(flagged).toBe(0);
      await replay(
        db,
        {
          ...prefix,
          blocks: prefix.blocks.filter((b) => b.number >= deployment),
        },
        LAUNCH_ON(),
      );
      await replay(db, canonical, LAUNCH_ON());
      expect(await dump(db)).toEqual(canonicalDump);
      await db.sql.end();
    }, 120_000);

    test("deleting launch event tables in any order, or whole blocks: committed ledgers and owners stay exact", async () => {
      const db = await canonicalReplay();
      const tables = [
        "zero_seed_launch_swapped",
        "zero_seed_launch_fees_paid",
        "zero_seed_launch_fees_claimed",
        "zero_seed_launch_owner_changed",
      ];
      for (const order of [tables, [...tables].reverse()]) {
        await db.sql.begin(async (tx) => {
          for (const table of order)
            await tx.unsafe(
              `DELETE FROM ${table} WHERE block_number > ${fixture.forkPoint}`,
            );
          await tx.unsafe(
            `DELETE FROM blocks WHERE block_number > ${fixture.forkPoint}`,
          );
        });
        await expectLedgerConsistent(db);
        await check(db, prefix.states.at(-1)!);
        await replay(db, canonical, LAUNCH_ON());
        expect(await dump(db)).toEqual(canonicalDump);
      }
      // Each canonical block alone, newest first: every intermediate commit is consistent.
      for (const block of [...canonical.blocks].reverse()) {
        await invalidateFrom(db.dao, block.number);
        await expectLedgerConsistent(db);
        const state = [...prefix.states, ...canonical.states]
          .filter((s) => s.blockNumber < block.number)
          .at(-1)!;
        await expectChainParity(db, state);
      }
      await db.sql.end();
    }, 120_000);

    test("redelivery: re-processing blocks, or re-sending every launch log, changes nothing and never double counts", async () => {
      const db = await canonicalReplay();
      const processors = LAUNCH_ON();
      const blocks = groupLogsByBlock(
        [...prefix.logs, ...canonical.logs],
        filtersOf(processors),
      );
      // the runtime's path: a block arriving again is deleted and rewritten
      for (const block of blocks.slice(-5))
        await applyBlock(db.dao, processors, block);
      expect(await dump(db)).toEqual(canonicalDump);
      // duplicate extension and periphery logs inside later transactions are ignored
      const launchOnly = createZeroSeedLaunchProcessors({
        coreAddress: CORE,
        zeroSeedLaunchAddresses: ALL,
      });
      for (let pass = 0; pass < 2; pass++)
        for (const block of groupLogsByBlock(
          [...prefix.logs, ...canonical.logs],
          filtersOf(launchOnly),
        ))
          await db.dao.begin((tx) =>
            processEvmBlock(
              launchOnly,
              block,
              Number(block.header.blockNumber),
              tx,
            ),
          );
      expect(await dump(db)).toEqual(canonicalDump);
      await db.sql.end();
    }, 120_000);

    test("orphans are refused: a swap or owner change whose creation is absent, or a launch on an unregistered pool", async () => {
      const db = await freshDb();
      const processors = LAUNCH_ON();
      await replay(db, prefix, processors);
      const blocks = groupLogsByBlock(canonical.logs, filtersOf(processors));
      // Drop l4's LaunchCreated from the block that created it: its owner
      // change in the same transaction is an orphan.
      const l4Pool = fixture.launches.l4.poolId;
      const createdBlock = blocks[0];
      const withoutCreation = {
        ...createdBlock,
        logs: createdBlock.logs.filter(
          (l) => !(l.topics[0] === LAUNCH_CREATED && l.topics[1] === l4Pool),
        ),
      };
      expect(withoutCreation.logs.length).toBe(createdBlock.logs.length - 1);
      await expectRejects(
        applyBlock(db.dao, processors, withoutCreation),
        /without LaunchCreated/,
      );
      // The refused block left nothing behind.
      const [{ n }] = await db.sql<
        { n: number }[]
      >`SELECT COUNT(*)::int AS n FROM blocks WHERE block_number = ${Number(createdBlock.header.blockNumber)}`;
      expect(n).toBe(0);
      await expectLedgerConsistent(db);

      // A launch processor without Core's pool registration (a config bug): LaunchCreated is refused.
      const db2 = await freshDb();
      const unregistered = processorsFor([]).concat(
        createZeroSeedLaunchProcessors({
          coreAddress: CORE,
          zeroSeedLaunchAddresses: ALL,
        }),
      );
      await expectRejects(
        replay(db2, prefix, unregistered),
        /not a registered launch pool/,
      );
      await db.sql.end();
      await db2.sql.end();
    }, 120_000);

    test("repair: recompute_zero_seed_launch_state restores a corrupted ledger and owner exactly", async () => {
      const db = await canonicalReplay();
      const before = await ledgerRows(db);
      await db.sql`UPDATE zero_seed_launch_states
                   SET accrued0 = accrued0 + 7, claim_count = 99, last_event_id = 0, paid1 = paid1 + 1,
                       current_owner = 1, initial_owner = NULL, owner_change_count = 0`;
      await db.sql`SELECT recompute_zero_seed_launch_state(pool_key_id) FROM zero_seed_launch_created`;
      expect(await ledgerRows(db)).toEqual(before);
      await db.sql.end();
    }, 120_000);

    test("claims and transfers do not move pool_last_event_id; creation and swaps do", async () => {
      const db = await freshDb();
      const processors = LAUNCH_ON();
      await replay(db, prefix, processors);
      const read = () => db.sql<{ pool_id: bigint; plei: bigint }[]>`
      SELECT pk.pool_id, plei.last_event_id AS plei FROM pool_last_event_id plei JOIN pool_keys pk USING (pool_key_id) ORDER BY 1`;
      const before = await read();
      // the alternate fork's first block, without its creation: a transfer and a claim of l1
      const claimsAndTransfers = alternate.logs.filter(
        (l) =>
          Number(l.blockNumber) === alternate.blocks[0].number &&
          [OWNER_CHANGED, FEES_PAID, CREATOR_FEES_CLAIMED].includes(
            l.topics[0],
          ) &&
          l.topics[1] !== fixture.launches.l3.poolId,
      );
      expect(claimsAndTransfers.length).toBe(3);
      const block = groupLogsByBlock(
        alternate.logs.filter((l) => claimsAndTransfers.includes(l)),
        filtersOf(processors),
      )[0];
      await applyBlock(db.dao, processors, block);
      expect(await read()).toEqual(before);
      await expectPoolLastEventId(db);
      await db.sql.end();
    }, 120_000);

    test("with no launch address, launch support is off: Core pools index, launch tables stay empty", async () => {
      const db = await freshDb();
      const processors = processorsFor([]);
      expect(
        processors.some((p) =>
          fixture.instances.some((i) =>
            [i.extension, i.periphery].some(
              (a) => a.toLowerCase() === p.address.toLowerCase(),
            ),
          ),
        ),
      ).toBe(false);
      await replay(db, prefix, processors);
      await replay(db, canonical, processors);
      const [row] = await db.sql<
        { pools: number; launch_rows: number; flagged: number }[]
      >`
      SELECT (SELECT COUNT(*)::int FROM all_pool_states_view) AS pools,
             (SELECT COUNT(*)::int FROM zero_seed_launch_pool_keys) + (SELECT COUNT(*)::int FROM zero_seed_launch_created)
               + (SELECT COUNT(*)::int FROM zero_seed_launch_swapped) + (SELECT COUNT(*)::int FROM zero_seed_launch_states)
               + (SELECT COUNT(*)::int FROM zero_seed_launch_owner_changed) + (SELECT COUNT(*)::int FROM zero_seed_launch_fees_paid) AS launch_rows,
             (SELECT COUNT(*)::int FROM all_pool_states_view WHERE is_zero_seed_launch_pool) AS flagged`;
      expect(row).toEqual({ pools: 7, launch_rows: 0, flagged: 0 });
      await db.sql.end();
    }, 120_000);
  },
);
