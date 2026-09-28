import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

let client: PGlite;

const CHAIN = 1;
const T0 = 1_700_000_000;
const HEAD = T0 + 300;
const ALICE = "11";
const BOB = "12";
const CAROL = "13";
const DAVE = "14";
const ERIN = "15";
const POSITIONS = "7000";
// 0.32 fractions
const FEE_A = 1n << 30n;
const FEE_B = 1n << 29n;
const FEE_C = 1n << 28n;

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

async function nftTransfer(blockNumber: number, eventIndex: number, tokenId: number, to: string) {
  await client.query(
    `INSERT INTO nonfungible_token_transfers
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
        token_id, from_address, to_address)
     VALUES ($1, $2, 0, $3, 1, $4, $5, 0, $6)`,
    [CHAIN, blockNumber, eventIndex, POSITIONS, tokenId, to],
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

  // Alice holds [T0+1, T0+101) at 10/s.
  await seedBlock(1, T0);
  await bidUpdated(1, 0, ALICE, 10, T0 + 1, T0 + 101, FEE_A);
  await nftTransfer(1, 1, 1, ERIN);
  await nftTransfer(1, 2, 2, ALICE);

  // Bob pays for one second at 20/s, which ends Alice's tenure 50s early and
  // leaves the pool closed after it.
  await seedBlock(2, T0 + 50);
  await rentSettled(2, 0, 490, true);
  await bidUpdated(2, 1, BOB, 20, T0 + 51, T0 + 52, FEE_B);

  // Carol's pending bid is displaced by Dave's in the same second.
  await seedBlock(3, T0 + 60);
  await rentSettled(3, 0, 30, true);
  await bidUpdated(3, 1, CAROL, 5, T0 + 61, T0 + 1000, FEE_C);
  await seedBlock(4, T0 + 60);
  await bidUpdated(4, 0, DAVE, 6, T0 + 61, T0 + 200, FEE_C);

  await seedBlock(5, T0 + 250);
  await rentSettled(5, 0, 480, true);
  await rentSettled(5, 1, 100, false);
  // Erin's NFT collects 200 and Alice's 100.
  await rentCollected(5, 2, 1, 200);
  await rentCollected(5, 3, 2, 100);
  await client.query(
    `INSERT INTO continuous_auction_swap_fee_charged
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
        pool_key_id, pool_id, bidder, amount0, amount1)
     VALUES ($1, 5, 0, 4, 1, 5000, $2, 0, $3, 5, 0)`,
    [CHAIN, pool, DAVE],
  );

  // What the monitor would write.
  await client.query(
    `INSERT INTO continuous_auction_tenure_executability
       (pool_key_id, bidder, bid_start, live_until, first_block_number, first_block_time, executable)
     VALUES ($1, $2, $3, $4, 2, $5, TRUE),
            ($1, $6, $7, $8, 3, $9, FALSE)`,
    [pool, ALICE, T0 + 1, T0 + 51, T0 + 50, BOB, T0 + 51, T0 + 52, T0 + 60],
  );
  // allocated 1000 - collected 300 - claimable 500: 200 discarded
  await client.query(
    `INSERT INTO continuous_auction_rent_reconciliations
       (pool_key_id, block_number, block_time, allocated, collected, claimable)
     VALUES ($1, 5, TO_TIMESTAMP($2), 1000, 300, 500)`,
    [pool, T0 + 250],
  );
});

afterAll(async () => {
  await client.close();
});

test("tenures are the seconds each bid held the pool", async () => {
  const { rows } = await client.query<Record<string, string>>(
    `SELECT bidder::text, live_from - $1 AS live_from, live_until - $1 AS live_until,
            live_seconds::text, scheduled_end - $1 AS scheduled_end, rent_paid::text
     FROM continuous_auction_tenures ORDER BY live_from`,
    [T0],
  );
  expect(rows).toEqual([
    { bidder: ALICE, live_from: 1, live_until: 51, live_seconds: "50", scheduled_end: 101, rent_paid: "500" },
    { bidder: BOB, live_from: 51, live_until: 52, live_seconds: "1", scheduled_end: 52, rent_paid: "20" },
    { bidder: DAVE, live_from: 61, live_until: 200, live_seconds: "139", scheduled_end: 200, rent_paid: "834" },
  ] as never);
});

test("displacements cover pending and live bids", async () => {
  const { rows } = await client.query<Record<string, string>>(
    `SELECT kind, displaced_at - $1 AS displaced_at, displacer::text, displaced::text,
            displaced_remaining_seconds, displacer_live_seconds
     FROM continuous_auction_displacements ORDER BY displaced_at`,
    [T0],
  );
  expect(rows).toEqual([
    {
      kind: "incumbent",
      displaced_at: 51,
      displacer: BOB,
      displaced: ALICE,
      displaced_remaining_seconds: 50,
      displacer_live_seconds: 1,
    },
    {
      kind: "pending",
      displaced_at: 60,
      displacer: DAVE,
      displaced: CAROL,
      displaced_remaining_seconds: 939,
      displacer_live_seconds: null,
    },
  ] as never);
});

test("rent collections are linked through the NFT owner", async () => {
  const { rows } = await client.query<Record<string, string>>(
    `SELECT beneficiary::text, linked_to_holder, amount::text
     FROM continuous_auction_rent_collections ORDER BY event_id`,
  );
  expect(rows).toEqual([
    { beneficiary: ERIN, linked_to_holder: false, amount: "200" },
    { beneficiary: ALICE, linked_to_holder: true, amount: "100" },
  ] as never);
});

test("pool metrics over the whole history", async () => {
  const {
    rows: [m],
  } = await client.query<Record<string, string>>(
    `SELECT window_from - $2 AS window_from, window_to - $2 AS window_to, observed_seconds,
            live_seconds, closed_seconds, closed_streak_seconds,
            rent_paid::text, rent_paid_unexecutable::text, rent_paid_unresolved::text,
            tenures, tenures_unexecutable,
            rent_allocated::text, rent_unallocated::text, rent_discarded_position_change::text,
            rent_collected::text, rent_collected_independent::text,
            round(top_beneficiary_share, 4)::text AS top_beneficiary_share,
            round(fee_time_weighted, 6)::text AS fee_time_weighted, fee_max::text,
            swap_fee_charges, displacements_pending, displacements_incumbent,
            displacements_then_closed
     FROM continuous_auction_pool_metrics($1, $2 - 1000, $2 + 1000)`,
    [CHAIN, T0],
  );
  expect(m).toEqual({
    window_from: 1,
    // clamped to the indexed head
    window_to: 300,
    observed_seconds: 299,
    live_seconds: 190,
    closed_seconds: 109,
    closed_streak_seconds: 100,
    rent_paid: "1354",
    rent_paid_unexecutable: "20",
    rent_paid_unresolved: "834",
    tenures: 3,
    tenures_unexecutable: 1,
    rent_allocated: "1000",
    rent_unallocated: "100",
    rent_discarded_position_change: "200",
    rent_collected: "300",
    rent_collected_independent: "200",
    top_beneficiary_share: "0.6667",
    // (0.25 * 50 + 0.125 * 1 + 0.0625 * 139) / 190
    fee_time_weighted: "0.112171",
    fee_max: "0.25000000000000000000",
    swap_fee_charges: 1,
    displacements_pending: 1,
    displacements_incumbent: 1,
    displacements_then_closed: 1,
  } as never);
});

test("a pool with a live bid at the end of the window has no closed streak", async () => {
  const {
    rows: [m],
  } = await client.query<Record<string, number>>(
    `SELECT observed_seconds, live_seconds, closed_seconds, closed_streak_seconds
     FROM continuous_auction_pool_metrics($1, $2 - 1000, $2 + 100)`,
    [CHAIN, T0],
  );
  expect(m).toEqual({
    observed_seconds: 99,
    live_seconds: 90,
    closed_seconds: 9,
    closed_streak_seconds: 0,
  } as never);
});

test("alerts use the chain's thresholds and stay quiet on short windows", async () => {
  // The defaults need an hour of history before the share alerts fire.
  const { rows: quiet } = await client.query(`SELECT * FROM continuous_auction_alerts($1)`, [
    CHAIN,
  ]);
  expect(quiet).toEqual([]);

  await client.query(
    `INSERT INTO continuous_auction_alert_thresholds
     VALUES ($1, 86400, 60, 86400, 60, 3600, 0.25, 0.5, 0.05, 0.2, 0.05)`,
    [CHAIN],
  );
  const { rows } = await client.query<Record<string, string>>(
    `SELECT alert, severity, round(value, 4)::text AS value, threshold::text
     FROM continuous_auction_alerts($1) ORDER BY alert`,
    [CHAIN],
  );
  expect(rows).toEqual([
    { alert: "closed_share", severity: "warn", value: "0.3645", threshold: "0.25" },
    { alert: "closed_streak", severity: "warn", value: "100.0000", threshold: "60" },
    // (100 unallocated + 200 discarded on position changes) / 1100 gross
    { alert: "discarded_rent_share", severity: "page", value: "0.2727", threshold: "0.2" },
  ] as never);

  // A pool with no live bid for longer than dormant_after_seconds is left to
  // the trend review. Dave's tenure ended 100s before the head.
  await client.query(
    `UPDATE continuous_auction_alert_thresholds SET dormant_after_seconds = 99 WHERE chain_id = $1`,
    [CHAIN],
  );
  const { rows: dormant } = await client.query(`SELECT * FROM continuous_auction_alerts($1)`, [
    CHAIN,
  ]);
  expect(dormant).toEqual([]);
});
