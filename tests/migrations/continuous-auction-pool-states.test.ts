import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

let client: PGlite;

beforeAll(async () => {
  client = await createClient();
});

afterAll(async () => {
  await client.close();
});

const T0 = 1_700_000_000;
const ALICE = "11";
const BOB = "12";
const CAROL = "13";
// 0.32 fractions
const FEE_A = 1n << 30n;
const FEE_B = 1n << 29n;
const FEE_C = 1n << 28n;

async function seedBlock(chainId: number, blockNumber: number, time: number) {
  await ensureIndexerCursor(client, chainId);
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, TO_TIMESTAMP($4), 0)`,
    [chainId, blockNumber, `${chainId}${blockNumber}`, time],
  );
}

async function seedPool(
  chainId: number,
  poolId: string,
  { registered }: { registered: boolean },
) {
  const {
    rows: [{ pool_key_id }],
  } = await client.query<{ pool_key_id: string }>(
    `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
                            fee_denominator, tick_spacing, pool_extension, pool_config,
                            pool_config_type)
     VALUES ($1, 1000, $2, 3000, 4000, 0, 1000000, 64, 5000, 0, 'concentrated')
     RETURNING pool_key_id`,
    [chainId, poolId],
  );
  await client.query(
    `INSERT INTO pool_states (pool_key_id, sqrt_ratio, tick, liquidity, last_event_id)
     VALUES ($1, 100, 0, 200, compute_event_id(1, 0, 0))`,
    [pool_key_id],
  );
  if (registered) {
    await client.query(
      `INSERT INTO continuous_auction_pool_keys (pool_key_id) VALUES ($1)`,
      [pool_key_id],
    );
  }
  return pool_key_id;
}

type EventPosition = {
  chainId: number;
  poolKeyId: string;
  blockNumber: number;
  eventIndex: number;
};

async function bidUpdated(
  { chainId, poolKeyId, blockNumber, eventIndex }: EventPosition,
  {
    bidder,
    rate,
    start,
    end,
    fee,
  }: { bidder: string; rate: bigint; start: number; end: number; fee: bigint },
) {
  await client.query(
    `INSERT INTO continuous_auction_bid_updated
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
        pool_key_id, pool_id, locker, salt, bidder, rate, bid_start, bid_end, executor, fee,
        delta)
     VALUES ($1, $2, 0, $3, 1, 5000, $4, 0, $5, 0, $5, $6, $7, $8, 77, $9, 0)`,
    [
      chainId,
      blockNumber,
      eventIndex,
      poolKeyId,
      bidder,
      rate.toString(),
      start,
      end,
      fee.toString(),
    ],
  );
}

async function rentSettled(
  { chainId, poolKeyId, blockNumber, eventIndex }: EventPosition,
  allocated = true,
) {
  await client.query(
    `INSERT INTO continuous_auction_rent_settled
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
        pool_key_id, pool_id, amount, allocated)
     VALUES ($1, $2, 0, $3, 1, 5000, $4, 0, 1, $5)`,
    [chainId, blockNumber, eventIndex, poolKeyId, allocated],
  );
}

type ViewRow = {
  current: [string, string, string] | null;
  next: [string, string, string] | null;
  last_settled: string | null;
  is_continuous_auction_pool: boolean;
  last_event_id: string;
};

async function view(poolKeyId: string): Promise<ViewRow> {
  const {
    rows: [row],
  } = await client.query<{
    cs: string | null;
    ce: string | null;
    cf: string | null;
    ns: string | null;
    ne: string | null;
    nf: string | null;
    last_settled: string | null;
    is_continuous_auction_pool: boolean;
    last_event_id: string;
  }>(
    `SELECT continuous_auction_current_bid_start::text AS cs,
            continuous_auction_current_bid_end::text   AS ce,
            continuous_auction_current_bid_fee::text   AS cf,
            continuous_auction_next_bid_start::text    AS ns,
            continuous_auction_next_bid_end::text      AS ne,
            continuous_auction_next_bid_fee::text      AS nf,
            continuous_auction_last_settled::text      AS last_settled,
            is_continuous_auction_pool,
            last_event_id::text
     FROM all_pool_states_view
     WHERE pool_key_id = $1`,
    [poolKeyId],
  );
  const bid = (s: string | null, e: string | null, f: string | null) =>
    s === null ? null : ([s, e!, f!] as [string, string, string]);
  return {
    current: bid(row!.cs, row!.ce, row!.cf),
    next: bid(row!.ns, row!.ne, row!.nf),
    last_settled: row!.last_settled,
    is_continuous_auction_pool: row!.is_continuous_auction_pool,
    last_event_id: row!.last_event_id,
  };
}

async function eventId(blockNumber: number, eventIndex: number) {
  const {
    rows: [{ id }],
  } = await client.query<{ id: string }>(
    `SELECT compute_event_id($1, 0, $2)::text AS id`,
    [blockNumber, eventIndex],
  );
  return id;
}

const bid = (start: number, end: number, fee: bigint) =>
  [String(start), String(end), fee.toString()] as [string, string, string];

test("mirrors auctions(poolId) through placement, displacement, activation and exit, and reorgs back exactly", async () => {
  const chainId = 1;
  const pool = await seedPool(chainId, "1", { registered: true });
  const at = (blockNumber: number, eventIndex: number) => ({
    chainId,
    poolKeyId: pool,
    blockNumber,
    eventIndex,
  });

  // A registered pool with no bid yet is flagged, with no schedule: the
  // quoter treats it as closed.
  expect(await view(pool)).toEqual({
    current: null,
    next: null,
    last_settled: null,
    is_continuous_auction_pool: true,
    last_event_id: await eventId(1, 0),
  });

  // Place: Alice's bid is pending from the next second.
  await seedBlock(chainId, 10, T0);
  await bidUpdated(at(10, 0), {
    bidder: ALICE,
    rate: 10n,
    start: T0 + 1,
    end: T0 + 101,
    fee: FEE_A,
  });
  expect(await view(pool)).toEqual({
    current: bid(0, 0, 0n),
    next: bid(T0 + 1, T0 + 101, FEE_A),
    last_settled: String(T0),
    is_continuous_auction_pool: true,
    last_event_id: await eventId(10, 0),
  });

  // Activation: the next settlement (a swap's RentAccrued) makes it current.
  await seedBlock(chainId, 11, T0 + 10);
  await rentSettled(at(11, 0));
  expect(await view(pool)).toMatchObject({
    current: bid(T0 + 1, T0 + 101, FEE_A),
    next: null,
    last_settled: String(T0 + 10),
    last_event_id: await eventId(11, 0),
  });

  // Bob outbids Alice. _updateBid settles first (RentAccrued), and his bid
  // waits as next while Alice's stays untruncated until the handover.
  await seedBlock(chainId, 12, T0 + 20);
  await rentSettled(at(12, 0));
  await bidUpdated(at(12, 1), {
    bidder: BOB,
    rate: 20n,
    start: T0 + 21,
    end: T0 + 221,
    fee: FEE_B,
  });
  expect(await view(pool)).toMatchObject({
    current: bid(T0 + 1, T0 + 101, FEE_A),
    next: bid(T0 + 21, T0 + 221, FEE_B),
    last_settled: String(T0 + 20),
  });

  // Displace: Carol outbids Bob's pending bid in the same second. No
  // settlement happens (same second), and Bob's bid is gone.
  await bidUpdated(at(12, 2), {
    bidder: CAROL,
    rate: 30n,
    start: T0 + 21,
    end: T0 + 321,
    fee: FEE_C,
  });
  const afterDisplace = {
    current: bid(T0 + 1, T0 + 101, FEE_A),
    next: bid(T0 + 21, T0 + 321, FEE_C),
    last_settled: String(T0 + 20),
    is_continuous_auction_pool: true,
    last_event_id: await eventId(12, 2),
  };
  expect(await view(pool)).toEqual(afterDisplace);

  // Activation again, this time with no active liquidity (RentUnallocated).
  await seedBlock(chainId, 13, T0 + 30);
  await rentSettled(at(13, 0), false);
  const afterActivation = {
    current: bid(T0 + 21, T0 + 321, FEE_C),
    next: null,
    last_settled: String(T0 + 30),
    is_continuous_auction_pool: true,
    last_event_id: await eventId(13, 0),
  };
  expect(await view(pool)).toEqual(afterActivation);

  // Exit: Carol removes her bid (rate 0), so her tenure ends at the next
  // second. Nothing is pending afterwards.
  await seedBlock(chainId, 14, T0 + 40);
  await rentSettled(at(14, 0));
  await bidUpdated(at(14, 1), {
    bidder: CAROL,
    rate: 0n,
    start: T0 + 41,
    end: T0 + 41,
    fee: 0n,
  });
  expect(await view(pool)).toMatchObject({
    current: bid(T0 + 21, T0 + 41, FEE_C),
    next: null,
    last_settled: String(T0 + 40),
  });

  // Reorgs unwind to the exact earlier states, including last_event_id.
  await client.query(`DELETE FROM blocks WHERE chain_id = $1 AND block_number = 14`, [chainId]);
  expect(await view(pool)).toEqual(afterActivation);
  await client.query(`DELETE FROM blocks WHERE chain_id = $1 AND block_number = 13`, [chainId]);
  expect(await view(pool)).toEqual(afterDisplace);
  await client.query(`DELETE FROM blocks WHERE chain_id = $1 AND block_number >= 10`, [chainId]);
  expect(await view(pool)).toEqual({
    current: null,
    next: null,
    last_settled: null,
    is_continuous_auction_pool: true,
    last_event_id: await eventId(1, 0),
  });
});

test("an owner replacing its pending bid keeps one next bid; another bidder's exit leaves it alone", async () => {
  const chainId = 2;
  const pool = await seedPool(chainId, "2", { registered: true });
  const at = (blockNumber: number, eventIndex: number) => ({
    chainId,
    poolKeyId: pool,
    blockNumber,
    eventIndex,
  });

  await seedBlock(chainId, 10, T0);
  await bidUpdated(at(10, 0), {
    bidder: ALICE,
    rate: 10n,
    start: T0 + 1,
    end: T0 + 101,
    fee: FEE_A,
  });
  // Alice replaces her own pending bid in the same second.
  await bidUpdated(at(10, 1), {
    bidder: ALICE,
    rate: 5n,
    start: T0 + 1,
    end: T0 + 51,
    fee: FEE_B,
  });
  // Bob, who holds nothing, exits: a no-op for the schedule.
  await bidUpdated(at(10, 2), {
    bidder: BOB,
    rate: 0n,
    start: T0 + 1,
    end: T0 + 1,
    fee: 0n,
  });
  expect(await view(pool)).toMatchObject({
    current: bid(0, 0, 0n),
    next: bid(T0 + 1, T0 + 51, FEE_B),
  });

  // A later bid update activates the pending bid before applying itself,
  // even with no rent event in between.
  await seedBlock(chainId, 11, T0 + 5);
  await bidUpdated(at(11, 0), {
    bidder: ALICE,
    rate: 0n,
    start: T0 + 6,
    end: T0 + 6,
    fee: 0n,
  });
  expect(await view(pool)).toMatchObject({
    current: bid(T0 + 1, T0 + 6, FEE_B),
    next: null,
    last_settled: String(T0 + 5),
  });
});

test("a pool with bid events is flagged even if its initialization predates the configured address", async () => {
  const chainId = 3;
  const pool = await seedPool(chainId, "3", { registered: false });
  expect((await view(pool)).is_continuous_auction_pool).toBe(false);

  await seedBlock(chainId, 10, T0);
  await bidUpdated(
    { chainId, poolKeyId: pool, blockNumber: 10, eventIndex: 0 },
    { bidder: ALICE, rate: 10n, start: T0 + 1, end: T0 + 101, fee: FEE_A },
  );
  expect((await view(pool)).is_continuous_auction_pool).toBe(true);
});

test("the recompute function matches the incrementally maintained state", async () => {
  const { rows: before } = await client.query(
    `SELECT * FROM continuous_auction_pool_states ORDER BY pool_key_id`,
  );
  await client.query(
    `SELECT recompute_continuous_auction_pool_state(pool_key_id) FROM pool_keys`,
  );
  const { rows: after } = await client.query(
    `SELECT * FROM continuous_auction_pool_states ORDER BY pool_key_id`,
  );
  expect(after).toEqual(before);
  expect(before.length).toBeGreaterThan(0);
});
