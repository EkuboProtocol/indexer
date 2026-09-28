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
const MIGRATION = "00130_market_depth_include_fee_band";

async function seedPool(
  client: Client,
  poolId: number,
  { fee, feeDenominator = 1_000_000 }: { fee: number; feeDenominator?: number }
) {
  const {
    rows: [{ pool_key_id }],
  } = await client.query<{ pool_key_id: string }>(
    `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
                            fee_denominator, tick_spacing, pool_extension)
     VALUES ($1, 2000, $2, 4000, 4001, $3, $4, 10, 0)
     RETURNING pool_key_id`,
    [CHAIN_ID, String(poolId), fee, feeDenominator]
  );
  return Number(pool_key_id);
}

/** Adds each position's liquidity to its lower tick and removes it at its upper. */
async function seedPositions(
  client: Client,
  poolKeyId: number,
  positions: [lower: number, upper: number, liquidity: string][]
) {
  const deltas = new Map<number, bigint>();
  for (const [lower, upper, liquidity] of positions) {
    deltas.set(lower, (deltas.get(lower) ?? 0n) + BigInt(liquidity));
    deltas.set(upper, (deltas.get(upper) ?? 0n) - BigInt(liquidity));
  }
  for (const [tick, delta] of deltas) {
    await client.query(
      `INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff,
                                                total_liquidity_on_tick)
       VALUES ($1, $2, $3::numeric, abs($3::numeric))`,
      [poolKeyId, tick, delta.toString()]
    );
  }
}

let nextEvent = 0;

async function seedSwap(client: Client, poolKeyId: number, tickAfter: number) {
  nextEvent += 1;
  await client.query(
    `INSERT INTO swaps (chain_id, block_number, transaction_index, event_index, transaction_hash,
                        emitter, pool_key_id, locker, delta0, delta1, sqrt_ratio_after, tick_after,
                        liquidity_after)
     VALUES ($1, 1, $2, 0, $3, 2000, $4, 3000, 1, -1, 1, $5, 1)`,
    [CHAIN_ID, nextEvent, String(nextEvent), poolKeyId, tickAfter]
  );
}

const L = 10n ** 18n;

/**
 * Three pools:
 * - usdg: the production case that prompted this. A 0.007% fee (70 ticks),
 *   price at tick -101, and every position inside [-210, 0], so most of its
 *   liquidity sits within one fee width of the price.
 * - expensive: a 1% fee (~9,951 ticks) is wider than most depth bands, which
 *   the old definition dropped entirely.
 * - clear: no liquidity within a fee width of the price, so nothing should move.
 */
async function seedFixture(client: Client) {
  await ensureIndexerCursor(client, CHAIN_ID);
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, 1, '1', $2, 1)`,
    [CHAIN_ID, BASE_TIME]
  );

  const usdg = await seedPool(client, 1, { fee: 70 });
  await seedPositions(client, usdg, [
    [-210, 0, (500n * L).toString()],
    [-140, 0, (300n * L).toString()],
    [-2_000, 2_000, (10n * L).toString()],
  ]);
  await seedSwap(client, usdg, -101);

  const expensive = await seedPool(client, 2, { fee: 10_000 });
  await seedPositions(client, expensive, [
    [-30_000, 30_000, (6n * L).toString()],
  ]);
  await seedSwap(client, expensive, 100);

  const clear = await seedPool(client, 3, { fee: 3_000 });
  await seedPositions(client, clear, [
    [-50_000, -4_000, (2n * L).toString()],
    [4_000, 50_000, (3n * L).toString()],
  ]);
  await seedSwap(client, clear, 0);

  return { usdg, expensive, clear };
}

type DepthRow = {
  pool_key_id: string;
  depth_percent: number;
  depth_in_ticks: number;
  depth0: string;
  depth1: string;
};

async function marketDepth(
  client: Client,
  relation: string,
  poolKeyId?: number
): Promise<DepthRow[]> {
  const { rows } = await client.query<DepthRow>(
    `SELECT pool_key_id::text,
            depth_percent,
            FLOOR(LN(1::NUMERIC + depth_percent) / LN(1.000001))::INT4 AS depth_in_ticks,
            depth0::text,
            depth1::text
     FROM ${relation}
     WHERE $1::int8 IS NULL OR pool_key_id = $1::int8
     ORDER BY pool_key_id, depth_percent`,
    [poolKeyId ?? null]
  );
  return rows;
}

/**
 * Token amounts held in [lower, upper] by liquidity l at price tick t, from the
 * concentrated-liquidity formulas directly rather than the view's prefix sums.
 * Returns [amount0, amount1] floored, as the view floors them.
 */
async function positionAmounts(
  client: Client,
  positions: [lower: number, upper: number, liquidity: bigint][],
  t: number
): Promise<[bigint, bigint]> {
  let amount0 = "0";
  let amount1 = "0";
  for (const [lower, upper, liquidity] of positions) {
    const {
      rows: [row],
    } = await client.query<{ a0: string; a1: string }>(
      `WITH p AS (SELECT POWER(1.0000005::NUMERIC, GREATEST($1::int, LEAST($3::int, $2::int))) AS s,
                         POWER(1.0000005::NUMERIC, $1::int)                                   AS sl,
                         POWER(1.0000005::NUMERIC, $2::int)                                   AS su)
       SELECT ($4::numeric + $5::numeric * (1::NUMERIC / s - 1::NUMERIC / su))::text AS a0,
              ($6::numeric + $5::numeric * (s - sl))::text                           AS a1
       FROM p`,
      [lower, upper, t, amount0, liquidity.toString(), amount1]
    );
    amount0 = row.a0;
    amount1 = row.a1;
  }
  const floor = (x: string) => BigInt(x.split(".")[0]);
  return [floor(amount0), floor(amount1)];
}

// Prefix sums and direct evaluation round POWER() at different points, so allow
// a unit of the floored result either way.
function expectClose(actual: string, expected: bigint) {
  const diff = BigInt(actual) - expected;
  expect(diff >= -1n && diff <= 1n).toBe(true);
}

test("liquidity within a fee width of the price is now counted", async () => {
  const client = new PGlite("memory://temp");
  await runMigrationsThrough(client, 129);
  const { usdg } = await seedFixture(client);

  const before = await marketDepth(client, "pool_market_depth_view", usdg);
  await runMigrations(client, { files: [MIGRATION] });
  const after = await marketDepth(client, "pool_market_depth_view", usdg);

  // Every band gains liquidity: the fee band is where most of this pool's is.
  expect(after.length).toBe(41);
  for (const row of after) {
    const old = before.find((r) => r.depth_percent === row.depth_percent);
    const oldTotal = old ? BigInt(old.depth0) + BigInt(old.depth1) : 0n;
    expect(BigInt(row.depth0) + BigInt(row.depth1)).toBeGreaterThan(oldTotal);
  }

  // Each band is exactly the liquidity in [tick - depth, tick + depth]:
  // clamping the positions to the band and valuing them at the current tick
  // must give the same amounts.
  const positions: [number, number, bigint][] = [
    [-210, 0, 500n * L],
    [-140, 0, 300n * L],
    [-2_000, 2_000, 10n * L],
  ];
  for (const row of after) {
    const lo = -101 - row.depth_in_ticks;
    const hi = -101 + row.depth_in_ticks;
    const clamped = positions
      .map(([a, b, l]): [number, number, bigint] => [
        Math.max(a, lo),
        Math.min(b, hi),
        l,
      ])
      .filter(([a, b]) => a < b);
    const [amount0, amount1] = await positionAmounts(client, clamped, -101);
    expectClose(row.depth0, amount0);
    expectClose(row.depth1, amount1);
  }

  // Once a band covers every position, depth is the pool's whole balance: the
  // ±0.106% band (1,055 ticks) holds everything but the wide 10e18 position's
  // tails, and the widest bands hold it all.
  const [tvl0, tvl1] = await positionAmounts(client, positions, -101);
  const widest = after[after.length - 1];
  expectClose(widest.depth0, tvl0);
  expectClose(widest.depth1, tvl1);

  // And the old definition really did miss most of it at that band.
  const band = (rows: DepthRow[]) =>
    rows.find((r) => r.depth_in_ticks === 1_055)!;
  const total = (r: DepthRow) => BigInt(r.depth0) + BigInt(r.depth1);
  expect(total(band(before)) * 2n).toBeLessThan(total(band(after)));

  await client.close();
});

test("a pool whose fee is wider than a band still gets a depth row for it", async () => {
  const client = new PGlite("memory://temp");
  await runMigrationsThrough(client, 129);
  const { expensive } = await seedFixture(client);

  const before = await marketDepth(client, "pool_market_depth_view", expensive);
  await runMigrations(client, { files: [MIGRATION] });
  const after = await marketDepth(client, "pool_market_depth_view", expensive);

  // The 1% fee is ~9,951 ticks; the old definition skipped every narrower band.
  expect(before.length).toBeLessThan(41);
  expect(before[0].depth_in_ticks).toBeGreaterThan(9_951);

  expect(after.length).toBe(41);
  for (const row of after) {
    expect(BigInt(row.depth0)).toBeGreaterThan(0n);
    expect(BigInt(row.depth1)).toBeGreaterThan(0n);
  }
  // The tightest band, 0.005% or 49 ticks, is well inside the fee.
  expect(after[0].depth_in_ticks).toBe(49);

  await client.close();
});

test("pools with no liquidity within a fee width of the price are unchanged", async () => {
  const client = new PGlite("memory://temp");
  await runMigrationsThrough(client, 129);
  const { clear } = await seedFixture(client);

  const before = await marketDepth(client, "pool_market_depth_view", clear);
  expect(before.length).toBeGreaterThan(0);
  await runMigrations(client, { files: [MIGRATION] });

  expect(await marketDepth(client, "pool_market_depth_view", clear)).toEqual(
    before
  );

  await client.close();
});

test("the materialized view and its concurrent refresh work on the new definition", async () => {
  const client = new PGlite("memory://temp");
  await runMigrationsThrough(client, 129);
  await seedFixture(client);
  await runMigrations(client, { files: [MIGRATION] });

  await client.exec(
    `REFRESH MATERIALIZED VIEW CONCURRENTLY pool_market_depth_materialized`
  );

  expect(await marketDepth(client, "pool_market_depth_materialized")).toEqual(
    await marketDepth(client, "pool_market_depth_view")
  );

  await client.close();
});
