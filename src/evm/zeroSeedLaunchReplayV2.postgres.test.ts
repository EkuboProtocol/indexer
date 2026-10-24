import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { decodeEventLog, encodeEventTopics, type Abi } from "viem";
import shift from "postgres-shift";
import { ZERO_SEED_LAUNCH_ABI } from "./abis_zero_seed_launch";
import { ZERO_SEED_LAUNCH_V2_ABI } from "./abis_zero_seed_launch_v2";
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
import {
  ZERO_SEED_LAUNCH_PINS,
  resolveZeroSeedLaunchPin,
} from "./zeroSeedLaunchConfig";

// The tick-rate fee model (evm-contracts 3d6378f, uint64 decayRateX32): logs a
// local anvil chain actually emitted for that revision
// (tests/fixtures/zero-seed-launch/local-chain-v2.json, written by
// scripts/zeroSeedLaunchFixture.ts at that head) are replayed through the
// stream grouping, processors, DAO and the 00140 triggers on a real Postgres,
// and the indexed state is checked against the chain after every block,
// including the contract's feeAt at each block. The SQL tick-rate functions
// are checked against the contract's frozen vectors (v7). The fixed-base
// model is covered unchanged by zeroSeedLaunchReplay.postgres.test.ts.
const SERVER = process.env.TEST_PG_CONNECTION_STRING;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) =>
  JSON.parse(
    readFileSync(
      resolve(ROOT, "tests/fixtures/zero-seed-launch", file),
      "utf8",
    ),
  );
// A postgres.js query runs only once awaited, so it is awaited inside an
// async function rather than handed to the matcher as a lazy thenable.
const expectRejects = (promise: PromiseLike<unknown>, error: RegExp) =>
  expect(
    (async () => {
      await promise;
    })(),
  ).rejects.toThrow(error) as unknown as Promise<void>;

type Hex = `0x${string}`;
type FixturePool = {
  label: string;
  poolId: Hex;
  poolStateWord: Hex;
  creatorFees: [string, string];
  launchOwner: Hex;
  controller: Hex;
  feeAtBlockTime: string;
  totalSupply: string;
  sinkBalance: string;
};
type FixtureState = { blockNumber: number; pools: FixturePool[] };
type Branch = {
  blocks: { number: number; timestamp: number }[];
  logs: RawLog[];
  states: FixtureState[];
};
const fixture = read("local-chain-v2.json") as {
  feeModel: string;
  chainId: number;
  provenance: Record<string, string>;
  addresses: Record<string, Hex>;
  instances: { extension: Hex; extensionRuntimeKeccak: Hex }[];
  launches: Record<string, { poolId: Hex }>;
  forkPoint: number;
  branches: { prefix: Branch; alternate: Branch; canonical: Branch };
};
const vectors = read("zero-seed-launch-v2-vectors.json");
const CHAIN_ID = BigInt(fixture.chainId);
const CORE = fixture.addresses.core;
const { prefix, alternate, canonical } = fixture.branches;
const MAX = 2n ** 64n - 1n;

const PIN = resolveZeroSeedLaunchPin({
  coreAddress: CORE,
  chainId: CHAIN_ID,
  address: fixture.instances[0].extension,
  runtimeCodehash: fixture.instances[0].extensionRuntimeKeccak,
  production: false,
})!;

const unused = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const processors = (): EvmLogProcessor[] =>
  createLogProcessorsV3({
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
    zeroSeedLaunchAddresses: [PIN.address],
  });
const filtersOf = (ps: EvmLogProcessor[]): LogStreamFilter[] =>
  ps.map((p, ix) => ({
    id: ix + 1,
    address: p.address,
    topics: p.filter.topics,
    strict: p.filter.strict,
  }));
const topic = (abi: Abi, eventName: string) =>
  encodeEventTopics({ abi, eventName })[0] as Hex;
const LAUNCH_CREATED_V1 = topic(ZERO_SEED_LAUNCH_ABI, "LaunchCreated");
const LAUNCH_CREATED_V2 = topic(ZERO_SEED_LAUNCH_V2_ABI, "LaunchCreated");
const num = (hex: string) => BigInt(hex).toString();

function decodePoolState(word: Hex) {
  const n = BigInt(word);
  return {
    sqrtRatio: floatSqrtRatioToFixed(n >> 160n),
    tick: Number(BigInt.asIntN(32, n >> 128n)),
    liquidity: n & ((1n << 128n) - 1n),
  };
}

type Db = {
  sql: Sql<{ bigint: bigint; numeric: bigint }>;
  dao: DAO;
  name: string;
};

describe.skipIf(!SERVER)(
  "zero-seed launch tick-rate model: replay of local chain logs on Postgres",
  () => {
    const template = `zsl2_template_${process.pid}_${Date.now()}`;
    const created: string[] = [];
    let admin: Sql;
    let counter = 0;
    const urlFor = (database: string) => {
      const url = new URL(SERVER!);
      url.pathname = `/${database}`;
      return url.toString();
    };

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
      return {
        sql,
        dao: Reflect.construct(DAO, [sql, CHAIN_ID]) as DAO,
        name,
      };
    }

    async function applyBlock(
      db: Db,
      ps: EvmLogProcessor[],
      block: StreamBlock,
    ) {
      const parsed = parseEvmBlockHeader(block)!;
      await db.dao.begin(async (tx) => {
        await tx.deleteOldBlockNumbers(parsed.header.number);
        await tx.insertBlock({
          number: parsed.header.number,
          hash: parsed.header.hash,
          time: new Date(parsed.header.timestamp),
          baseFeePerGas: null,
          numEvents: block.logs.reduce((n, log) => n + log.filterIds.length, 0),
        });
        await processEvmBlock(ps, parsed.block, parsed.header.number, tx);
      });
    }

    async function replay(
      db: Db,
      branch: Branch,
      check?: (state: FixtureState) => Promise<void>,
    ) {
      const ps = processors();
      const blocks = groupLogsByBlock(branch.logs, filtersOf(ps));
      for (const fixtureBlock of branch.blocks) {
        const block = blocks.find(
          (b) => Number(b.header.blockNumber) === fixtureBlock.number,
        );
        if (block) await applyBlock(db, ps, block);
        const state = branch.states.find(
          (s) => s.blockNumber === fixtureBlock.number,
        )!;
        if (check) await check(state);
      }
    }

    /** Indexed Core state, ledger, owner, supply and SQL feeAt equal the chain at this block. */
    async function expectChainParity(db: Db, state: FixtureState) {
      for (const pool of state.pools) {
        const [row] = await db.sql<
          {
            sqrt_ratio: bigint;
            tick: number;
            liquidity: bigint;
            unclaimed0: bigint;
            unclaimed1: bigint;
            current_owner: bigint;
            controller: bigint;
            requested_supply: bigint;
            sink_supply: bigint;
            fee_at: bigint;
          }[]
        >`
        SELECT ps.sqrt_ratio, ps.tick, ps.liquidity, s.accrued0 - s.claimed0 AS unclaimed0,
               s.accrued1 - s.claimed1 AS unclaimed1, s.current_owner, c.controller,
               c.requested_supply, c.sink_supply,
               zero_seed_launch_model_fee_at(c.fee_model, c.trading_start, c.fee_duration, c.decay_rate_x32,
                                             c.initial_fee, c.final_fee,
                                             (SELECT EXTRACT(EPOCH FROM MAX(block_time))::int8 FROM blocks)) AS fee_at
        FROM pool_keys pk
                 JOIN pool_states ps USING (pool_key_id)
                 JOIN zero_seed_launch_states s USING (pool_key_id)
                 JOIN zero_seed_launch_created c USING (pool_key_id)
        WHERE pk.chain_id = ${CHAIN_ID} AND pk.pool_id = ${num(pool.poolId)}::numeric`;
        expect(row, `${pool.label} indexed`).toBeDefined();
        expect({
          sqrtRatio: row.sqrt_ratio,
          tick: row.tick,
          liquidity: row.liquidity,
        }).toEqual(decodePoolState(pool.poolStateWord));
        expect([String(row.unclaimed0), String(row.unclaimed1)]).toEqual(
          pool.creatorFees,
        );
        expect([row.current_owner, row.controller]).toEqual([
          BigInt(pool.launchOwner),
          BigInt(pool.controller),
        ]);
        expect(String(row.fee_at), `${pool.label} feeAt`).toBe(
          pool.feeAtBlockTime,
        );
        expect([String(row.requested_supply), String(row.sink_supply)]).toEqual(
          [pool.totalSupply, pool.sinkBalance],
        );
      }
    }

    async function dump(db: Db) {
      const q = (text: string) =>
        db.sql.unsafe(text).then((rows) => rows.map((r) => ({ ...r })));
      return {
        created: await q(
          `SELECT c.*, NULL AS pool_key_id FROM zero_seed_launch_created c ORDER BY event_id`,
        ),
        swapped: await q(
          `SELECT w.*, NULL AS pool_key_id FROM zero_seed_launch_swapped w ORDER BY event_id`,
        ),
        states: await q(
          `SELECT pk.pool_id, s.accrued0, s.accrued1, s.claimed0, s.claimed1, s.paid0, s.paid1, s.current_owner
           FROM zero_seed_launch_states s JOIN pool_keys pk USING (pool_key_id) ORDER BY pk.pool_id`,
        ),
        view: await q(
          `SELECT pool_id, zero_seed_launch_fee_model, zero_seed_launch_fee_duration,
                  zero_seed_launch_decay_rate_x32, zero_seed_launch_initial_fee, zero_seed_launch_final_fee
           FROM all_pool_states_view v JOIN pool_keys USING (pool_key_id)
           WHERE is_zero_seed_launch_pool ORDER BY pool_id`,
        ),
      };
    }

    test("the v2 fixture is the frozen tick-rate revision and resolves to the v2 pin", () => {
      expect(fixture.feeModel).toBe("tick_rate_v2");
      expect(fixture.provenance.evmContractsHead).toBe(
        "3d6378f585591dc7eabeea6976932c30524bb8ea",
      );
      expect(PIN.feeModel).toBe("tick_rate_v2");
      expect(PIN).toBe(ZERO_SEED_LAUNCH_PINS[1]);
      expect(LAUNCH_CREATED_V2).toBe(
        "0x8f81ce1beb182cad759aa1c797ef027d374f535fd0c08696441c32797c7a5888",
      );
      // Every creation log of this deployment carries the v2 topic, never the v1 one.
      const topics = new Set(
        [...prefix.logs, ...canonical.logs, ...alternate.logs]
          .filter((l) => BigInt(l.address) === BigInt(PIN.address))
          .map((l) => l.topics[0]),
      );
      expect(topics.has(LAUNCH_CREATED_V2)).toBe(true);
      expect(topics.has(LAUNCH_CREATED_V1)).toBe(false);
    });

    test("canonical replay equals chain state after every block, with the rates stored exactly", async () => {
      const db = await freshDb();
      await replay(db, prefix, (s) => expectChainParity(db, s));
      await replay(db, canonical, (s) => expectChainParity(db, s));
      const rows = await db.sql<
        {
          pool_id: bigint;
          fee_model: string;
          fee_duration: bigint | null;
          fee_end: bigint | null;
          decay_rate_x32: string;
          initial_fee: string;
          final_fee: string;
        }[]
      >`
      SELECT pool_id, fee_model, fee_duration, fee_end, decay_rate_x32::TEXT, initial_fee::TEXT, final_fee::TEXT
      FROM zero_seed_launch_created ORDER BY event_id`;
      // The decayRateX32 of every emitted LaunchCreated, decoded with the v2 ABI.
      const emitted = new Map(
        [...prefix.logs, ...canonical.logs]
          .filter((l) => l.topics[0] === LAUNCH_CREATED_V2)
          .map((l) => {
            const { args } = decodeEventLog({
              abi: ZERO_SEED_LAUNCH_V2_ABI,
              eventName: "LaunchCreated",
              topics: l.topics as [Hex],
              data: l.data,
              strict: true,
            });
            return [
              BigInt(args!.poolId),
              args!.parameters.decayRateX32,
            ] as const;
          }),
      );
      expect(rows.length).toBe(7);
      for (const r of rows) {
        expect([r.fee_model, r.fee_duration, r.fee_end]).toEqual([
          "tick_rate_v2",
          null,
          null,
        ]);
        expect(BigInt(r.decay_rate_x32)).toBe(emitted.get(r.pool_id)!);
      }
      // Zero, one, the one-day default, the 600 s rate and 2^64 - 1 are all
      // indexed exactly (the quarter tick per second launch is on the fork).
      expect(new Set(rows.map((r) => r.decay_rate_x32))).toEqual(
        new Set(["0", "1", "68913100933", "9923486534471", MAX.toString()]),
      );
      const dumped = await dump(db);
      expect(
        dumped.view.map((v) => [
          v.zero_seed_launch_fee_model,
          v.zero_seed_launch_fee_duration,
        ]),
      ).toEqual(rows.map(() => ["tick_rate_v2", null]));
      await db.sql.end();
    }, 300_000);

    test("every swap: fee rate is the tick-rate feeAt at its block, including the floor and the flat rates", async () => {
      const db = await freshDb();
      await replay(db, prefix);
      await replay(db, canonical);
      const rows = await db.sql<
        {
          ok: boolean;
          started: boolean;
          rate: string;
          fee_rate: string;
          final_fee: string;
          initial_fee: string;
        }[]
      >`
      SELECT w.fee_rate = zero_seed_launch_model_fee_at(c.fee_model, c.trading_start, c.fee_duration,
                                                         c.decay_rate_x32, c.initial_fee, c.final_fee,
                                                         EXTRACT(EPOCH FROM b.block_time)::int8) AS ok,
             EXTRACT(EPOCH FROM b.block_time)::int8 > c.trading_start AS started,
             c.decay_rate_x32::TEXT AS rate, w.fee_rate::TEXT, c.final_fee::TEXT, c.initial_fee::TEXT
      FROM zero_seed_launch_swapped w
               JOIN zero_seed_launch_created c USING (pool_key_id)
               JOIN blocks b ON b.chain_id = w.chain_id AND b.block_number = w.block_number`;
      expect(rows.length).toBeGreaterThan(15);
      expect(rows.filter((r) => !r.ok)).toEqual([]);
      // Rate 0 never decays; 2^64 - 1 is at the floor from the first second.
      for (const r of rows.filter((r) => r.rate === "0"))
        expect(r.fee_rate).toBe(r.initial_fee);
      const maxRate = rows.filter(
        (r) => r.rate === MAX.toString() && r.started,
      );
      expect(maxRate.length).toBeGreaterThan(0);
      for (const r of maxRate) expect(r.fee_rate).toBe(r.final_fee);
      await db.sql.end();
    }, 300_000);

    test("reorg: the alternate fork, then the canonical branch, equals a straight replay", async () => {
      const straight = await freshDb();
      await replay(straight, prefix);
      await replay(straight, canonical);
      const expected = await dump(straight);
      await straight.sql.end();

      const db = await freshDb();
      await replay(db, prefix);
      await replay(db, alternate, (s) => expectChainParity(db, s));
      // The fork's extra launch decays at a quarter tick per second.
      const [{ rate }] = await db.sql<{ rate: string }[]>`
        SELECT decay_rate_x32::TEXT AS rate FROM zero_seed_launch_created
        WHERE pool_id = ${num(fixture.launches.l3.poolId)}::numeric`;
      expect(rate).toBe(String(1n << 30n));
      await db.dao.begin((tx) =>
        tx.deleteOldBlockNumbers(fixture.forkPoint + 1),
      );
      await replay(db, canonical, (s) => expectChainParity(db, s));
      expect(await dump(db)).toEqual(expected);
      await db.sql.end();
    }, 300_000);

    test("rows carry exactly their model's parameter: the table refuses mixed, unknown or out-of-range schedules", async () => {
      const db = await freshDb();
      await replay(db, prefix);
      const copy = (
        model: string,
        duration: string,
        rate: string,
        offset = 1000,
      ) =>
        db.sql.begin((tx) =>
          tx.unsafe(
            `INSERT INTO zero_seed_launch_created
               (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
                pool_key_id, pool_id, token, controller, quote_token, position_id, liquidity, requested_supply,
                installed_supply, name, symbol, decimals, ask_tick, upper_tick, tick_spacing, trading_start,
                fee_model, fee_duration, decay_rate_x32, initial_fee, final_fee, salt)
               SELECT chain_id, block_number, transaction_index, event_index + ${offset}, transaction_hash, emitter,
                      NULL, pool_id, token, controller, quote_token, position_id, liquidity, requested_supply,
                      installed_supply, name, symbol, decimals, ask_tick, upper_tick, tick_spacing, trading_start,
                      ${model}, ${duration}, ${rate}, initial_fee, final_fee, salt
               FROM zero_seed_launch_created LIMIT 1`,
          ),
        );
      for (const [model, duration, rate] of [
        ["'tick_rate_v2'", "3600", "68913100933"],
        ["'tick_rate_v2'", "NULL", "NULL"],
        ["'tick_rate_v2'", "NULL", "18446744073709551616"],
        ["'tick_rate_v2'", "NULL", "-1"],
        ["'tick_rate_v2'", "NULL", "1.5"],
        ["'fixed_base_duration_v1'", "3600", "68913100933"],
        ["'fixed_base_duration_v1'", "0", "NULL"],
        ["'other'", "NULL", "1"],
      ])
        await expectRejects(copy(model, duration, rate), /check constraint/);
      // The boundaries themselves are accepted.
      await copy("'tick_rate_v2'", "NULL", "0", 2000);
      await copy("'tick_rate_v2'", "NULL", MAX.toString(), 3000);
      await expectRejects(
        db.sql`SELECT zero_seed_launch_model_fee_at('tick_rate_v2', 0, 3600, 1, 1, 0, 1)`,
        /invalid zero-seed launch fee model/,
      );
      await expectRejects(
        db.sql`SELECT zero_seed_launch_model_fee_at('fixed_base_duration_v1', 0, 3600, 1, 1, 0, 1)`,
        /invalid zero-seed launch fee model/,
      );
      await db.sql.end();
    }, 300_000);

    test("SQL tick-rate math reproduces the contract's frozen v7 vectors bit for bit", async () => {
      const db = await freshDb();
      // Elapsed seconds beyond int8 cannot be a timestamp; every positive rate
      // has saturated long before, so those rows take 2^62 seconds.
      const clamp = (t: string) =>
        BigInt(t) > 2n ** 62n ? (2n ** 62n).toString() : t;
      const fee = async (
        i: string,
        f: string,
        rate: string,
        elapsed: string,
      ) => {
        const t = clamp(elapsed);
        const [{ v }] = await db.sql<{ v: string }[]>`
          SELECT zero_seed_launch_model_fee_at('tick_rate_v2', 1000, NULL, ${rate}::NUMERIC,
                                               ${i}::NUMERIC, ${f}::NUMERIC,
                                               (1000 + ${t}::NUMERIC)::int8)::TEXT AS v`;
        return v;
      };
      expect(vectors.version).toBe(7);
      const fx = vectors.fixture;
      for (const row of vectors.fee)
        expect(
          await fee(
            fx.fee_initial_q64,
            fx.fee_final_q64,
            row.decayRateX32,
            row.t_minus_start,
          ),
          JSON.stringify(row),
        ).toBe(row.fee_q64);
      const curve = vectors.fee_curve;
      const rates = curve.rates_q64;
      const decay = curve.decay_rates_x32;
      const f03 = curve.final_fee_q64;
      const tables: [string, string, string, string][] = [
        ["default_one_day_50_to_0.3", rates["50"], f03, decay.default_one_day],
        [
          "two_ticks_per_second_50_to_0.3",
          rates["50"],
          f03,
          decay.two_ticks_per_second,
        ],
        [
          "two_ticks_per_second_99.9_to_0",
          rates["99.9"],
          "0",
          decay.two_ticks_per_second,
        ],
        [
          "default_one_day_max_to_0",
          MAX.toString(),
          "0",
          decay.default_one_day,
        ],
        ["min_rate_max_to_0", MAX.toString(), "0", "1"],
      ];
      for (const [name, i, f, rate] of tables)
        for (const row of curve.tables[name])
          expect(await fee(i, f, rate, row.t), `${name} ${row.t}`).toBe(
            row.fee_q64,
          );
      for (const steps of curve.tick_steps) {
        const initial =
          BigInt(steps.rows[0].fee_q64) === BigInt(f03) + 1n
            ? (BigInt(f03) + 1n).toString()
            : rates["50"];
        for (const row of steps.rows)
          expect(await fee(initial, f03, steps.decayRateX32, row.t)).toBe(
            row.fee_q64,
          );
      }
      for (const [name, second] of Object.entries(curve.saturation_second)) {
        const rate = decay[name];
        expect(
          await fee(
            MAX.toString(),
            "0",
            rate,
            String(BigInt(second as string) + 1n),
          ),
        ).toBe("0");
      }
      // The five SHA-256 chains over whole curves, as the contract tests pin them.
      for (const chain of curve.digests_sha256) {
        const rows = await db.sql<{ v: string }[]>`
          SELECT zero_seed_launch_tick_rate_fee(${chain.initialFee}::NUMERIC, ${chain.finalFee}::NUMERIC,
                                                ${chain.decayRateX32}::NUMERIC, t::NUMERIC)::TEXT AS v
          FROM generate_series(0, ${chain.last}::int8, ${chain.step}::int8) t ORDER BY t`;
        let h: Buffer = Buffer.alloc(32);
        for (const { v } of rows) {
          const word = Buffer.alloc(8);
          word.writeBigUInt64BE(BigInt(v));
          h = createHash("sha256").update(h).update(word).digest();
        }
        expect(h.toString("hex"), chain.label).toBe(chain.digest);
      }
      // The helper's range: the last magnitude is supported, one more raises.
      const [{ last }] = await db.sql<{ last: string }[]>`
        SELECT zero_seed_launch_tick_factor_q128(88722835)::TEXT AS last`;
      expect(last).toBe("18447191164202170524");
      await expectRejects(
        db.sql`SELECT zero_seed_launch_tick_factor_q128(88722836)`,
        /outside 0..88722835/,
      );
      await db.sql.end();
    }, 600_000);
  },
);
