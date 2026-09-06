import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  createClient,
  ensureIndexerCursor,
  runMigrations,
  runMigrationsThrough,
} from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

const CHAIN_ID = 7;
const BASE_TIME = new Date("2024-01-01T12:00:00Z");

async function seedBlock(client: Client, blockNumber: number, at: Date) {
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT DO NOTHING`,
    [CHAIN_ID, blockNumber, String(blockNumber), at]
  );
}

async function seedPool(
  client: Client,
  poolId: number,
  { fee = 100, feeDenominator = 1_000_000 } = {}
) {
  const {
    rows: [{ pool_key_id }],
  } = await client.query<{ pool_key_id: string }>(
    `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
                            fee_denominator, tick_spacing, pool_extension)
     VALUES ($1, 2000, $2, 4000, 4001, $3, $4, 60, 0)
     RETURNING pool_key_id`,
    [CHAIN_ID, String(poolId), fee, feeDenominator]
  );
  return Number(pool_key_id);
}

async function seedTicks(
  client: Client,
  poolKeyId: number,
  ticks: [tick: number, delta: string][]
) {
  for (const [tick, delta] of ticks) {
    await client.query(
      `INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff,
                                                total_liquidity_on_tick)
       VALUES ($1, $2, $3::numeric, abs($3::numeric))`,
      [poolKeyId, tick, delta]
    );
  }
}

let nextEvent = 0;

async function seedSwap(
  client: Client,
  poolKeyId: number,
  blockNumber: number,
  tickAfter: number,
  liquidityAfter: string
) {
  nextEvent += 1;
  await client.query(
    `INSERT INTO swaps (chain_id, block_number, transaction_index, event_index, transaction_hash,
                        emitter, pool_key_id, locker, delta0, delta1, sqrt_ratio_after, tick_after,
                        liquidity_after)
     VALUES ($1, $2, $3, 0, $4, 2000, $5, 3000, 1, -1, 1, $6, $7::numeric)`,
    [CHAIN_ID, blockNumber, nextEvent, String(nextEvent), poolKeyId, tickAfter, liquidityAfter]
  );
}

async function setPoolState(client: Client, poolKeyId: number, tick: number) {
  await client.query(
    `INSERT INTO pool_states (pool_key_id, sqrt_ratio, liquidity, tick, last_event_id)
     VALUES ($1, 1, 0, $2, 1)
     ON CONFLICT (pool_key_id) DO UPDATE SET tick = EXCLUDED.tick`,
    [poolKeyId, tick]
  );
}

/**
 * Six pools chosen to cover every branch the rewrite touches: bands that fall
 * inside the tick range, bands that run off both ends of it, a pool whose
 * liquidity returns to zero in the middle, a pool priced from pool_states
 * because it has never swapped, a pool with no ticks at all, and a pool whose
 * fee is wider than the tightest depth bands.
 */
async function seedFixture(client: Client) {
  await ensureIndexerCursor(client, CHAIN_ID);
  await seedBlock(client, 1, new Date(BASE_TIME.getTime() - 4 * 60 * 60 * 1000));
  await seedBlock(client, 2, new Date(BASE_TIME.getTime() - 40 * 60 * 1000));
  await seedBlock(client, 3, new Date(BASE_TIME.getTime() - 10 * 60 * 1000));
  await seedBlock(client, 4, BASE_TIME);

  // 1. Wide tick range, so most bands land strictly inside it.
  const wide = await seedPool(client, 1);
  await seedTicks(client, wide, [
    [-120_000, "1000000000000000000"],
    [-40_000, "5000000000000000000"],
    [-500, "70000000000000000000"],
    [500, "-70000000000000000000"],
    [40_000, "-5000000000000000000"],
    [120_000, "-1000000000000000000"],
  ]);
  await seedSwap(client, wide, 2, 40, "76000000000000000000");
  await seedSwap(client, wide, 3, 60, "76000000000000000000");
  await seedSwap(client, wide, 4, 20, "76000000000000000000");
  // Older than the one-hour window: must not move the median.
  await seedSwap(client, wide, 1, 90_000, "76000000000000000000");

  // 2. Narrow tick range, so every band runs off both ends.
  const narrow = await seedPool(client, 2);
  await seedTicks(client, narrow, [
    [-300, "9000000000000000000"],
    [300, "-9000000000000000000"],
  ]);
  await seedSwap(client, narrow, 3, 0, "9000000000000000000");

  // 3. Liquidity drops back to zero between two populated ranges.
  const gapped = await seedPool(client, 3);
  await seedTicks(client, gapped, [
    [-8_000, "3000000000000000000"],
    [-2_000, "-3000000000000000000"],
    [2_000, "4000000000000000000"],
    [8_000, "-4000000000000000000"],
  ]);
  await seedSwap(client, gapped, 3, -1_000, "3000000000000000000");

  // 4. Never swapped: last_tick has to come from pool_states.
  const unswapped = await seedPool(client, 4);
  await seedTicks(client, unswapped, [
    [-5_000, "2000000000000000000"],
    [5_000, "-2000000000000000000"],
  ]);
  await setPoolState(client, unswapped, 1_200);

  // 5. No ticks at all: contributes no rows to either definition.
  const empty = await seedPool(client, 5);
  await seedSwap(client, empty, 3, 0, "1000000000000000000");

  // 6. A 1% fee is wider than the tightest bands, which are skipped entirely.
  const expensive = await seedPool(client, 6, { fee: 10_000 });
  await seedTicks(client, expensive, [
    [-30_000, "6000000000000000000"],
    [30_000, "-6000000000000000000"],
  ]);
  await seedSwap(client, expensive, 3, 100, "6000000000000000000");

  return { wide, narrow, gapped, unswapped, empty, expensive };
}

async function marketDepth(client: Client, relation: string) {
  const { rows } = await client.query<{
    pool_key_id: string;
    depth_percent: number;
    depth0: string;
    depth1: string;
  }>(
    `SELECT pool_key_id::text, depth_percent, depth0::text, depth1::text
     FROM ${relation}
     ORDER BY pool_key_id, depth_percent`
  );
  return rows;
}

test("the rewritten view returns exactly what the old definition returned", async () => {
  const client = new PGlite("memory://temp");
  await runMigrationsThrough(client, 125);
  const pools = await seedFixture(client);

  const before = await marketDepth(client, "pool_market_depth_view");

  // The fixture has to actually exercise the thing, or parity is vacuous.
  expect(before.length).toBeGreaterThan(100);
  expect(new Set(before.map((r) => r.pool_key_id)).size).toBe(5);
  expect(before.some((r) => BigInt(r.depth0) > 0n)).toBe(true);
  expect(before.some((r) => BigInt(r.depth1) > 0n)).toBe(true);

  await runMigrations(client, { files: ["00126_faster_pool_market_depth"] });

  const after = await marketDepth(client, "pool_market_depth_view");

  // Exact, not approximate: NUMERIC + - * are lossless and both definitions
  // round POWER() and 1/p at the same ticks, so every digit has to match.
  expect(after).toEqual(before);

  // The pool with no ticks is absent from both.
  expect(after.some((r) => r.pool_key_id === String(pools.empty))).toBe(false);
  // The 1% fee pool keeps only the bands wider than its fee.
  const expensiveRows = after.filter(
    (r) => r.pool_key_id === String(pools.expensive)
  );
  expect(expensiveRows.length).toBeGreaterThan(0);
  expect(expensiveRows.length).toBeLessThan(41);

  await client.close();
});

test("the materialized view and its concurrent refresh still work on the new definition", async () => {
  const client = new PGlite("memory://temp");
  await runMigrationsThrough(client, 125);
  await seedFixture(client);
  await runMigrations(client, { files: ["00126_faster_pool_market_depth"] });

  // This is what the cron job runs; it needs the unique index from 00024 and it
  // is the step that would fail if the replaced view changed shape.
  await client.exec(
    `REFRESH MATERIALIZED VIEW CONCURRENTLY pool_market_depth_materialized`
  );

  expect(await marketDepth(client, "pool_market_depth_materialized")).toEqual(
    await marketDepth(client, "pool_market_depth_view")
  );

  await client.close();
});

test("the median still ignores swaps older than the hour before the last one", async () => {
  const client = new PGlite("memory://temp");
  await runMigrationsThrough(client, 126);
  await ensureIndexerCursor(client, CHAIN_ID);
  await seedBlock(client, 1, new Date(BASE_TIME.getTime() - 4 * 60 * 60 * 1000));
  await seedBlock(client, 2, BASE_TIME);

  const pool = await seedPool(client, 20);
  await seedTicks(client, pool, [
    [-50_000, "4000000000000000000"],
    [50_000, "-4000000000000000000"],
  ]);
  await seedSwap(client, pool, 2, 0, "4000000000000000000");
  const inWindowOnly = await marketDepth(client, "pool_market_depth_view");

  // A swap four hours before the newest one: outside the window, so the median
  // tick -- and therefore every depth -- must not move. OFFSET 0 is only a
  // planner fence, and this is what proves it stayed one.
  await seedSwap(client, pool, 1, 45_000, "4000000000000000000");
  expect(await marketDepth(client, "pool_market_depth_view")).toEqual(
    inWindowOnly
  );

  await client.close();
});
