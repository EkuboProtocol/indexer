import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

let client: PGlite;

// Day-aligned so the UTC buckets are exact.
const T0 = 1_699_920_000;
const DAY = 86_400;
const HEAD = T0 + 100_000;
const CHAIN = 1;
const ALICE = "11";
const BOB = "12";
const ERIN = "15";
const POSITIONS = "7000";
// 0.32 fractions: 0.25 and 0.125.
const FEE_A = 1n << 30n;
const FEE_B = 1n << 29n;

let pool: string;

async function seedBlock(blockNumber: number, time: number) {
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, TO_TIMESTAMP($4), 1)`,
    [CHAIN, blockNumber, `${CHAIN}${blockNumber}`, time],
  );
}

async function bidUpdated(
  blockNumber: number,
  eventIndex: number,
  bidder: string,
  rate: number,
  start: number,
  end: number,
  fee: bigint,
) {
  await client.query(
    `INSERT INTO continuous_auction_bid_updated
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
        pool_key_id, pool_id, locker, salt, bidder, rate, bid_start, bid_end, executor, fee,
        delta)
     VALUES ($1, $2, 0, $3, 1, 5000, $4, 0, $5, 0, $5, $6, $7, $8, 77, $9, 0)`,
    [CHAIN, blockNumber, eventIndex, pool, bidder, rate, start, end, fee.toString()],
  );
}

async function rentSettled(
  blockNumber: number,
  eventIndex: number,
  amount: number,
  allocated: boolean,
) {
  await client.query(
    `INSERT INTO continuous_auction_rent_settled
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
        pool_key_id, pool_id, amount, allocated)
     VALUES ($1, $2, 0, $3, 1, 5000, $4, 0, $5, $6)`,
    [CHAIN, blockNumber, eventIndex, pool, amount, allocated],
  );
}

async function rentCollected(blockNumber: number, eventIndex: number, salt: number, amount: number) {
  await client.query(
    `INSERT INTO continuous_auction_rent_collected
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
        pool_key_id, pool_id, owner, position_id, salt, lower_bound, upper_bound, amount)
     VALUES ($1, $2, 0, $3, 1, 5000, $4, 0, $5, 0, $6, -64, 64, $7)`,
    [CHAIN, blockNumber, eventIndex, pool, POSITIONS, salt, amount],
  );
}

beforeAll(async () => {
  client = await createClient();
  await ensureIndexerCursor(client, CHAIN);
  await client.query(
    `UPDATE indexer_cursor SET head_block_time = TO_TIMESTAMP($2) WHERE chain_id = $1`,
    [CHAIN, HEAD],
  );

  const {
    rows: [row],
  } = await client.query<{ pool_key_id: string }>(
    `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
                            fee_denominator, tick_spacing, pool_extension, pool_config,
                            pool_config_type)
     VALUES ($1, 1000, 1, 3000, 4000, 0, 1000000, 64, 5000, 0, 'concentrated')
     RETURNING pool_key_id`,
    [CHAIN],
  );
  pool = row.pool_key_id;
  await client.query(`INSERT INTO continuous_auction_pool_keys (pool_key_id) VALUES ($1)`, [pool]);

  // Alice holds [T0+1, T0+86401) at 10/s, cut short by Bob one second into day 1.
  await seedBlock(1, T0);
  await bidUpdated(1, 0, ALICE, 10, T0 + 1, T0 + 90_000, FEE_A);
  await client.query(
    `INSERT INTO nonfungible_token_transfers
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
        token_id, from_address, to_address)
     VALUES ($1, 1, 0, 1, 1, $2, 1, 0, $3),
            ($1, 1, 0, 2, 1, $2, 2, 0, $4)`,
    [CHAIN, POSITIONS, ERIN, ALICE],
  );

  // Bob holds [T0+86401, T0+86411) at 20/s, displacing Alice with 3599s left.
  await seedBlock(2, T0 + 86_401);
  await rentSettled(2, 0, 864_000, true);
  await bidUpdated(2, 1, BOB, 20, T0 + 86_401, T0 + 86_411, FEE_B);

  await seedBlock(3, T0 + 90_000);
  await rentSettled(3, 0, 200, true);
  await rentSettled(3, 1, 50, false);
  // Erin's NFT collects 500 (independent); Alice's collects 100 (holder-linked).
  await rentCollected(3, 2, 1, 500);
  await rentCollected(3, 3, 2, 100);
  await client.query(
    `INSERT INTO continuous_auction_swap_fee_charged
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
        pool_key_id, pool_id, bidder, amount0, amount1)
     VALUES ($1, 3, 0, 4, 1, 5000, $2, 0, $3, 5, 0)`,
    [CHAIN, pool, BOB],
  );

  // What the monitor would write.
  await client.query(
    `INSERT INTO continuous_auction_tenure_executability
       (pool_key_id, bidder, bid_start, live_until, first_block_number, first_block_time, executable)
     VALUES ($1, $2, $3, $4, 2, $5, TRUE),
            ($1, $6, $7, $8, 3, $9, FALSE)`,
    [pool, ALICE, T0 + 1, T0 + 86_401, T0 + 86_401, BOB, T0 + 86_401, T0 + 86_411, T0 + 90_000],
  );
  // allocated 864200 - collected 600 - claimable 863400: 200 discarded.
  await client.query(
    `INSERT INTO continuous_auction_rent_reconciliations
       (pool_key_id, block_number, block_time, allocated, collected, claimable)
     VALUES ($1, 3, TO_TIMESTAMP($2), 864200, 600, 863400)`,
    [pool, T0 + 90_000],
  );
});

afterAll(async () => {
  await client.close();
});

test("daily metrics split the tenures at the UTC day boundary", async () => {
  const { rows } = await client.query<Record<string, string>>(
    `SELECT day_start - $2 AS day_start, day_end - $2 AS day_end,
            observed_seconds::text, live_seconds::text, closed_seconds::text,
            closed_streak_seconds::text,
            gross_rent_paid::text, rent_paid_unresolved::text,
            rent_allocated::text, rent_unallocated::text,
            rent_discarded_position_change::text,
            rent_collected::text, net_rent_independent::text,
            swap_fee_charges::text,
            displacements_pending::text, displacements_incumbent::text,
            displacements_then_closed::text
     FROM continuous_auction_daily_metrics($1, $2, $3) ORDER BY day_start`,
    [CHAIN, T0, HEAD],
  );
  expect(rows).toEqual([
    {
      // Day 0: Alice alone, 86399 of 86399 observed seconds live.
      day_start: 0,
      day_end: DAY,
      observed_seconds: "86399",
      live_seconds: "86399",
      closed_seconds: "0",
      closed_streak_seconds: "0",
      gross_rent_paid: "863990",
      rent_paid_unresolved: "0",
      rent_allocated: "0",
      rent_unallocated: "0",
      rent_discarded_position_change: null,
      rent_collected: "0",
      net_rent_independent: "0",
      swap_fee_charges: "0",
      displacements_pending: "0",
      displacements_incumbent: "0",
      displacements_then_closed: "0",
    },
    {
      // Day 1: Alice's last second plus Bob's 10s; the pool then closes.
      day_start: DAY,
      day_end: 100_000,
      observed_seconds: "13600",
      live_seconds: "11",
      closed_seconds: "13589",
      closed_streak_seconds: "13589",
      gross_rent_paid: "210",
      rent_paid_unresolved: "0",
      rent_allocated: "864200",
      rent_unallocated: "50",
      rent_discarded_position_change: "200",
      rent_collected: "600",
      net_rent_independent: "500",
      swap_fee_charges: "1",
      displacements_pending: "0",
      displacements_incumbent: "1",
      displacements_then_closed: "1",
    },
  ] as never);
});

test("daily derived shares match the dashboard definitions", async () => {
  const {
    rows: [day0, day1],
  } = await client.query<Record<string, string>>(
    `SELECT round(access_share, 6)::text AS access_share,
            round(unexecutable_rent_share, 6)::text AS unexecutable_rent_share,
            round(usable_access_share, 6)::text AS usable_access_share,
            round(independent_share_of_gross, 6)::text AS independent_share_of_gross,
            round(discarded_rent_share, 6)::text AS discarded_rent_share,
            round(fee_time_weighted, 6)::text AS fee_time_weighted,
            fee_max::text AS fee_max,
            round(top_beneficiary_share, 6)::text AS top_beneficiary_share
     FROM continuous_auction_daily_metrics($1, $2, $3) ORDER BY day_start`,
    [CHAIN, T0, HEAD],
  );
  expect(day0).toEqual({
    access_share: "1.000000",
    unexecutable_rent_share: "0.000000",
    usable_access_share: "1.000000",
    // 0 collected / 863990 paid.
    independent_share_of_gross: "0.000000",
    discarded_rent_share: null,
    fee_time_weighted: "0.250000",
    fee_max: "0.25000000000000000000",
    top_beneficiary_share: null,
  } as never);
  expect(day1).toEqual({
    // 11 live of 13600 observed seconds.
    access_share: "0.000809",
    // Bob's 200 of 210 paid for a tenure with no executable block.
    unexecutable_rent_share: "0.952381",
    usable_access_share: "0.000039",
    // 500 independent of 210 gross: collections lag payments, so the share
    // can exceed 1 over short windows.
    independent_share_of_gross: "2.380952",
    // (50 unallocated + 200 position-change discards) / 864250 gross.
    discarded_rent_share: "0.000289",
    // (0.25 * 1 + 0.125 * 10) / 11.
    fee_time_weighted: "0.136364",
    fee_max: "0.25000000000000000000",
    top_beneficiary_share: "0.833333",
  } as never);
});

test("trailing 24h covers [head - 86400, head]", async () => {
  const {
    rows: [m],
  } = await client.query<Record<string, string>>(
    `SELECT window_from - $2 AS window_from, window_to - $2 AS window_to,
            observed_seconds::text, live_seconds::text, closed_seconds::text,
            gross_rent_paid::text, net_rent_independent::text,
            round(independent_share_of_gross, 6)::text AS independent_share_of_gross,
            round(usable_access_share, 6)::text AS usable_access_share,
            round(discarded_rent_share, 6)::text AS discarded_rent_share
     FROM continuous_auction_trailing_24h_metrics($1)`,
    [CHAIN, T0],
  );
  expect(m).toEqual({
    window_from: 13_600,
    window_to: 100_000,
    observed_seconds: "86400",
    // Alice [T0+13600, T0+86401) plus Bob's 10s.
    live_seconds: "72811",
    closed_seconds: "13589",
    gross_rent_paid: "728210",
    net_rent_independent: "500",
    independent_share_of_gross: "0.000687",
    usable_access_share: "0.842488",
    discarded_rent_share: "0.000289",
  } as never);
});

test("windows with no observed pools render empty", async () => {
  const { rows: daily } = await client.query(
    `SELECT * FROM continuous_auction_daily_metrics($1, $2, $3)`,
    [CHAIN, T0 + 200_000, T0 + 200_100],
  );
  expect(daily).toEqual([]);
  const { rows: trailing } = await client.query(
    `SELECT * FROM continuous_auction_trailing_24h_metrics($1) WHERE pool_key_id = -1`,
    [CHAIN],
  );
  expect(trailing).toEqual([]);
});
