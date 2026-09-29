import { expect, test } from "bun:test";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

const CHAIN_ID = 7;
const DAY = 86400;
const T0 = Date.parse("2024-01-01T00:00:00Z") / 1000;
const ONE = 1n << 64n;
const FEE = ONE / 100n; // 1%

async function seedBlock(client: Client, blockNumber: number, at: number) {
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, TO_TIMESTAMP($4), 1)
     ON CONFLICT DO NOTHING`,
    [CHAIN_ID, blockNumber, String(blockNumber), at]
  );
}

async function seedPool(client: Client, poolId: number, mevCapture: boolean) {
  const {
    rows: [{ pool_key_id }],
  } = await client.query<{ pool_key_id: string }>(
    `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
                            fee_denominator, tick_spacing, pool_extension)
     VALUES ($1, 2000, $2, 4000, 4001, $3, $4, 100, 5555)
     RETURNING pool_key_id`,
    [CHAIN_ID, String(poolId), FEE.toString(), ONE.toString()]
  );
  if (mevCapture) {
    await client.query(`INSERT INTO mev_capture_pool_keys (pool_key_id) VALUES ($1)`, [pool_key_id]);
  }
  await seedBlock(client, 1, T0 - DAY);
  await client.query(
    `INSERT INTO pool_initializations (chain_id, block_number, transaction_index, event_index,
                                       transaction_hash, emitter, pool_key_id, tick, sqrt_ratio)
     VALUES ($1, 1, 0, $2, 1, 2000, $3, 0, 1)`,
    [CHAIN_ID, poolId, pool_key_id]
  );
  return Number(pool_key_id);
}

async function swap(
  client: Client,
  pool: number,
  block: number,
  tx: number,
  logIndex: number,
  delta0: bigint,
  delta1: bigint,
  tickAfter: number,
  liquidityAfter: bigint
) {
  await client.query(
    `INSERT INTO swaps (chain_id, block_number, transaction_index, event_index, transaction_hash,
                        emitter, pool_key_id, locker, delta0, delta1, sqrt_ratio_after, tick_after,
                        liquidity_after)
     VALUES ($1, $2, $3, $4, $5, 2000, $6, 3000, $7, $8, 1, $9, $10)`,
    [CHAIN_ID, block, tx, logIndex, String(block * 1000 + tx), pool, delta0.toString(), delta1.toString(), tickAfter, liquidityAfter.toString()]
  );
}

async function donation(client: Client, pool: number, block: number, logIndex: number, amount0: bigint, amount1: bigint) {
  await client.query(
    `INSERT INTO fees_accumulated (chain_id, block_number, transaction_index, event_index,
                                   transaction_hash, emitter, pool_key_id, delta0, delta1)
     VALUES ($1, $2, 0, $3, $4, 2000, $5, $6, $7)`,
    [CHAIN_ID, block, logIndex, String(block * 1000), pool, amount0.toString(), amount1.toString()]
  );
}

async function seed() {
  const client = await createClient();
  await ensureIndexerCursor(client, CHAIN_ID);
  const pool = await seedPool(client, 1, true);
  const plain = await seedPool(client, 2, false);
  for (const [block, at] of [[10, T0 + 60], [12, T0 + 120], [14, T0 + DAY + 60], [15, T0 + DAY + 72]] as const) {
    await seedBlock(client, block, at);
  }
  // Block 10: two swaps; the first touch moves the tick from the initial 0.
  await swap(client, pool, 10, 3, 5, 10_001n, -9_000n, 150, 1000n);
  await swap(client, pool, 10, 4, 9, 20_000n, -18_000n, 300, 900n);
  await swap(client, plain, 10, 5, 11, 1_000n, -900n, 10, 50n);
  // Block 12 first donates block 10's accrual, then swaps back.
  await donation(client, pool, 12, 0, 0n, 777n);
  await swap(client, pool, 12, 1, 1, -5_000n, 5_600n, 250, 900n);
  // Block 14 swaps with no donation in between: block 12 accrued nothing.
  await swap(client, pool, 14, 0, 0, 100n, -90n, 250, 1200n);
  return { client, pool, plain };
}

type BlockRow = Record<string, string | number | null>;

async function blockSeries(client: Client, from: number, to: number) {
  const { rows } = await client.query<BlockRow>(
    `SELECT pool_key_id, block_number::int AS block_number, swaps::int AS swaps,
            amount_in0::text, amount_in1::text, amount_out0::text, amount_out1::text,
            base_fee0::text, base_fee1::text, surcharge0::text, surcharge1::text,
            surcharge_donation_block::int AS surcharge_donation_block, tick_last, tick_after_last_swap,
            liquidity_before_first_swap::text, liquidity_after_last_swap::text,
            first_touch_transaction_hash::text, first_touch_transaction_index, first_touch_event_index
     FROM mev_capture_block_series($1, $2, $3)
     ORDER BY pool_key_id, block_number`,
    [CHAIN_ID, from, to]
  );
  return rows;
}

test("block series covers MEVCapture pools only, with first touch, tick_last and base fee on input", async () => {
  const { client, pool } = await seed();
  const rows = await blockSeries(client, T0, T0 + 2 * DAY);
  expect(rows.map((r) => [r.pool_key_id, r.block_number])).toEqual([
    [pool, 10],
    [pool, 12],
    [pool, 14],
  ]);
  expect(rows[0]).toMatchObject({
    swaps: 2,
    amount_in0: "30001",
    amount_out1: "27000",
    // FEE is floor(2^64 / 100): ceil(100.00999..) + ceil(199.99999..)
    base_fee0: "301",
    base_fee1: "0",
    tick_last: 0,
    tick_after_last_swap: 300,
    liquidity_before_first_swap: null,
    liquidity_after_last_swap: "900",
    first_touch_transaction_hash: "10003",
    first_touch_transaction_index: 3,
    first_touch_event_index: 5,
  });
  expect(rows[1]).toMatchObject({ tick_last: 300, base_fee1: "56", liquidity_before_first_swap: "900" });
});

test("a donation is attributed to the pool's last earlier swapping block; later states are zero or pending", async () => {
  const { client } = await seed();
  const rows = await blockSeries(client, T0, T0 + 2 * DAY);
  expect(rows.map((r) => [r.block_number, r.surcharge0, r.surcharge1, r.surcharge_donation_block])).toEqual([
    [10, "0", "777", 12],
    [12, "0", "0", null],
    [14, null, null, null],
  ]);
});

test("a donation arriving after the range still settles an in-range block", async () => {
  const { client } = await seed();
  await donation(client, 1, 15, 0, 3n, 0n);
  const rows = await blockSeries(client, T0 + DAY, T0 + DAY + 70);
  expect(rows.map((r) => [r.block_number, r.surcharge0, r.surcharge_donation_block])).toEqual([[14, "3", 15]]);
});

test("daily metrics aggregate the block series per UTC day", async () => {
  const { client, pool } = await seed();
  const { rows } = await client.query<Record<string, string | number>>(
    `SELECT day_start::int8::text, pool_key_id, swaps::int AS swaps, first_touch_swaps::int AS first_touch_swaps,
            base_fee0::text, base_fee1::text, surcharge1::text,
            blocks_surcharge_pending::int AS pending, liquidity_last::text
     FROM mev_capture_daily_metrics($1, $2, $3)`,
    [CHAIN_ID, T0, T0 + 2 * DAY]
  );
  expect(rows).toEqual([
    { day_start: String(T0), pool_key_id: pool, swaps: 3, first_touch_swaps: 2, base_fee0: "301", base_fee1: "56", surcharge1: "777", pending: 0, liquidity_last: "900" },
    { day_start: String(T0 + DAY), pool_key_id: pool, swaps: 1, first_touch_swaps: 1, base_fee0: "1", base_fee1: "0", surcharge1: "0", pending: 1, liquidity_last: "1200" },
  ]);
});
