import { beforeAll, afterAll, test, expect } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "001_chain_tables.sql",
  "002_core_tables.sql",
  "019_hourly_tables.sql",
  "026_hourly_tables_block_time.sql",
  "028_fees_accumulated_block_time.sql",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  await client.close();
});

async function seedPool(
  pgClient: PGlite,
  options: { chainId: number; blockNumber: number; blockTime?: Date }
) {
  const { chainId, blockNumber } = options;
  const blockTime = options.blockTime ?? new Date("2024-01-01T00:00:00Z");
  const blockHash = `${blockNumber}${chainId}`;

  await pgClient.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
     VALUES ($1, $2, $3, $4)`,
    [chainId, blockNumber, blockHash, blockTime]
  );

  const {
    rows: [{ pool_key_id }],
  } = await pgClient.query<{ pool_key_id: bigint }>(
    `INSERT INTO pool_keys (
        chain_id,
        core_address,
        pool_id,
        token0,
        token1,
        fee,
        fee_denominator,
        tick_spacing,
        pool_extension
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING pool_key_id`,
    [chainId, "2000", "3000", "4000", "4001", "100", "1000000", 60, "5000"]
  );

  return {
    chainId,
    blockNumber,
    poolKeyId: Number(pool_key_id),
  };
}

function computeEventId(
  blockNumber: number,
  transactionIndex: number,
  eventIndex: number
) {
  const blockLimit = 2n ** 32n;
  const indexLimit = 2n ** 16n;
  return (
    -9223372036854775807n +
    BigInt(blockNumber) * blockLimit +
    BigInt(transactionIndex) * indexLimit +
    BigInt(eventIndex)
  );
}

test("swap trigger updates hourly volume and price data", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, {
    chainId: 101,
    blockNumber: 1000,
  });

  const {
    rows: [{ event_id: firstEventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO swaps (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        delta0,
        delta1,
        sqrt_ratio_after,
        tick_after,
        liquidity_after
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "6000",
      "7000",
      poolKeyId,
      "8000",
      "100",
      "-50",
      "9101112",
      15,
      "100000",
    ]
  );

  const {
    rows: [{ block_time: firstSwapBlockTime }],
  } = await client.query<{ block_time: string }>(
    `SELECT block_time::text AS block_time
     FROM swaps
     WHERE chain_id = $1 AND event_id = $2`,
    [chainId, firstEventId]
  );
  expect(firstSwapBlockTime).toBe("2024-01-01 00:00:00+00");

  let volumeRows = await client.query<{
    volume: string;
    fees: string;
  }>(
    `SELECT volume, fees
     FROM hourly_volume_by_token
     WHERE pool_key_id = $1 AND token = $2`,
    [poolKeyId, "4000"]
  );

  expect(volumeRows.rows.length).toBe(1);
  expect(volumeRows.rows[0]).toMatchObject({
    volume: "100",
    fees: "1",
  });

  let priceRows = await client.query<{
    k_volume: string;
    total: string;
  }>(
    `SELECT k_volume, total
     FROM hourly_price_data
     WHERE chain_id = $1 AND token0 = $2 AND token1 = $3`,
    [chainId, "4000", "4001"]
  );

  expect(priceRows.rows.length).toBe(1);
  expect(priceRows.rows[0]).toMatchObject({
    k_volume: "5000",
    total: "2500",
  });

  const {
    rows: [{ event_id: secondEventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO swaps (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        delta0,
        delta1,
        sqrt_ratio_after,
        tick_after,
        liquidity_after
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      1,
      "6001",
      "7001",
      poolKeyId,
      "8001",
      "30",
      "-10",
      "9101113",
      16,
      "100001",
    ]
  );

  volumeRows = await client.query(
    `SELECT volume, fees
     FROM hourly_volume_by_token
     WHERE pool_key_id = $1 AND token = $2`,
    [poolKeyId, "4000"]
  );

  expect(volumeRows.rows.length).toBe(1);
  expect(volumeRows.rows[0]).toMatchObject({
    volume: "130",
    fees: "2",
  });

  priceRows = await client.query(
    `SELECT k_volume, total
     FROM hourly_price_data
     WHERE chain_id = $1 AND token0 = $2 AND token1 = $3`,
    [chainId, "4000", "4001"]
  );

  expect(priceRows.rows.length).toBe(1);
  expect(priceRows.rows[0]).toMatchObject({
    k_volume: "5300",
    total: "2600",
  });

  await client.query(
    `DELETE FROM swaps WHERE chain_id = $1 AND event_id = $2`,
    [chainId, secondEventId]
  );

  volumeRows = await client.query(
    `SELECT volume, fees
     FROM hourly_volume_by_token
     WHERE pool_key_id = $1 AND token = $2`,
    [poolKeyId, "4000"]
  );

  expect(volumeRows.rows.length).toBe(1);
  expect(volumeRows.rows[0]).toMatchObject({
    volume: "100",
    fees: "1",
  });

  priceRows = await client.query(
    `SELECT k_volume, total
     FROM hourly_price_data
     WHERE chain_id = $1 AND token0 = $2 AND token1 = $3`,
    [chainId, "4000", "4001"]
  );

  expect(priceRows.rows.length).toBe(1);
  expect(priceRows.rows[0]).toMatchObject({
    k_volume: "5000",
    total: "2500",
  });

  await client.query(
    `DELETE FROM swaps WHERE chain_id = $1 AND event_id = $2`,
    [chainId, firstEventId]
  );

  const remainingVolume = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM hourly_volume_by_token
     WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  expect(remainingVolume.rows[0].count).toBe("0");

  const remainingPrice = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM hourly_price_data
     WHERE chain_id = $1`,
    [chainId]
  );
  expect(remainingPrice.rows[0].count).toBe("0");
});

test("swap trigger ignores zero-volume events", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, {
    chainId: 102,
    blockNumber: 1001,
  });

  await client.query(
    `INSERT INTO swaps (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        delta0,
        delta1,
        sqrt_ratio_after,
        tick_after,
        liquidity_after
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "6100",
      "7100",
      poolKeyId,
      "8100",
      "-10",
      "0",
      "9101114",
      17,
      "100002",
    ]
  );

  const volumeCount = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM hourly_volume_by_token
     WHERE pool_key_id = $1`,
    [poolKeyId]
  );

  expect(volumeCount.rows[0].count).toBe("0");

  const priceCount = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM hourly_price_data
     WHERE chain_id = $1`,
    [chainId]
  );

  expect(priceCount.rows[0].count).toBe("0");
});

test("fees accumulated trigger upserts hourly fees", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, {
    chainId: 105,
    blockNumber: 1004,
  });

  const {
    rows: [{ event_id }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO fees_accumulated (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        delta0,
        delta1
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING event_id`,
    [chainId, blockNumber, 0, 0, "6300", "7300", poolKeyId, "15", "25"]
  );

  const {
    rows: [{ block_time }],
  } = await client.query<{ block_time: string }>(
    `SELECT block_time::text AS block_time
     FROM fees_accumulated
     WHERE chain_id = $1 AND event_id = $2`,
    [chainId, event_id]
  );

  expect(block_time).toBe("2024-01-01 00:00:00+00");

  const token0Rows = await client.query<{
    volume: string;
    fees: string;
  }>(
    `SELECT volume, fees
     FROM hourly_volume_by_token
     WHERE pool_key_id = $1 AND token = $2`,
    [poolKeyId, "4000"]
  );

  expect(token0Rows.rows.length).toBe(1);
  expect(token0Rows.rows[0]).toMatchObject({
    volume: "0",
    fees: "15",
  });

  const token1Rows = await client.query<{
    volume: string;
    fees: string;
  }>(
    `SELECT volume, fees
     FROM hourly_volume_by_token
     WHERE pool_key_id = $1 AND token = $2`,
    [poolKeyId, "4001"]
  );

  expect(token1Rows.rows.length).toBe(1);
  expect(token1Rows.rows[0]).toMatchObject({
    volume: "0",
    fees: "25",
  });

  await client.query(
    `DELETE FROM fees_accumulated WHERE chain_id = $1 AND event_id = $2`,
    [chainId, event_id]
  );

  const remaining = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM hourly_volume_by_token
     WHERE pool_key_id = $1`,
    [poolKeyId]
  );

  expect(remaining.rows[0].count).toBe("0");
});

test("protocol fees trigger aggregates revenue and latest event id", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, {
    chainId: 103,
    blockNumber: 1002,
  });

  const {
    rows: [{ event_id: firstFeeEventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO protocol_fees_paid (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        salt,
        lower_bound,
        upper_bound,
        delta0,
        delta1
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "6200",
      "7200",
      poolKeyId,
      "8200",
      "9200",
      -100,
      100,
      "-5",
      "0",
    ]
  );

  const {
    rows: [{ event_id: secondFeeEventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO protocol_fees_paid (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        salt,
        lower_bound,
        upper_bound,
        delta0,
        delta1
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      1,
      "6201",
      "7201",
      poolKeyId,
      "8201",
      "9201",
      -90,
      110,
      "-7",
      "0",
    ]
  );

  const revenueRows = await client.query<{
    revenue: string;
  }>(
    `SELECT revenue
     FROM hourly_revenue_by_token
     WHERE pool_key_id = $1 AND token = $2`,
    [poolKeyId, "4000"]
  );

  expect(revenueRows.rows.length).toBe(1);
  expect(revenueRows.rows[0].revenue).toBe("12");

  await client.query(
    `DELETE FROM protocol_fees_paid
     WHERE chain_id = $1 AND event_id = $2`,
    [chainId, secondFeeEventId]
  );

  const revenueAfterSecondDelete = await client.query<{
    revenue: string;
  }>(
    `SELECT revenue
     FROM hourly_revenue_by_token
     WHERE pool_key_id = $1 AND token = $2`,
    [poolKeyId, "4000"]
  );

  expect(revenueAfterSecondDelete.rows.length).toBe(1);
  expect(revenueAfterSecondDelete.rows[0].revenue).toBe("5");

  await client.query(
    `DELETE FROM protocol_fees_paid
     WHERE chain_id = $1 AND event_id = $2`,
    [chainId, firstFeeEventId]
  );

  const revenueAfterAllDeletes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM hourly_revenue_by_token
     WHERE pool_key_id = $1`,
    [poolKeyId]
  );

  expect(revenueAfterAllDeletes.rows[0].count).toBe("0");
});

test("pool balance change trigger updates tvl delta and latest event id", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, {
    chainId: 104,
    blockNumber: 1003,
  });

  const firstEventId = computeEventId(blockNumber, 0, 10);
  const secondEventId = computeEventId(blockNumber, 0, 11);

  await client.query(
    `INSERT INTO pool_balance_change (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        event_id,
        pool_key_id,
        delta0,
        delta1
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      chainId,
      blockNumber,
      0,
      10,
      "6300",
      "7300",
      firstEventId.toString(),
      poolKeyId,
      "12",
      "0",
    ]
  );

  await client.query(
    `INSERT INTO pool_balance_change (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        event_id,
        pool_key_id,
        delta0,
        delta1
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      chainId,
      blockNumber,
      0,
      11,
      "6301",
      "7301",
      secondEventId.toString(),
      poolKeyId,
      "-2",
      "4",
    ]
  );

  const tvlRows = await client.query<{
    token: string;
    delta: string;
  }>(
    `SELECT token, delta
     FROM hourly_tvl_delta_by_token
     WHERE pool_key_id = $1
     ORDER BY token`,
    [poolKeyId]
  );

  expect(tvlRows.rows.length).toBe(2);

  const deltaForToken0 = tvlRows.rows.find((row) => row.token === "4000");
  expect(deltaForToken0).toBeDefined();
  expect(deltaForToken0?.delta).toBe("10");

  const deltaForToken1 = tvlRows.rows.find((row) => row.token === "4001");
  expect(deltaForToken1).toBeDefined();
  expect(deltaForToken1?.delta).toBe("4");

  await client.query(
    `DELETE FROM pool_balance_change
     WHERE chain_id = $1 AND event_id = $2`,
    [chainId, secondEventId.toString()]
  );

  const tvlAfterSecondDelete = await client.query<{
    token: string;
    delta: string;
  }>(
    `SELECT token, delta
     FROM hourly_tvl_delta_by_token
     WHERE pool_key_id = $1
     ORDER BY token`,
    [poolKeyId]
  );

  expect(tvlAfterSecondDelete.rows.length).toBe(1);
  expect(tvlAfterSecondDelete.rows[0]).toMatchObject({
    token: "4000",
    delta: "12",
  });

  await client.query(
    `DELETE FROM pool_balance_change
     WHERE chain_id = $1 AND event_id = $2`,
    [chainId, firstEventId.toString()]
  );

  const tvlAfterAllDeletes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM hourly_tvl_delta_by_token
     WHERE pool_key_id = $1`,
    [poolKeyId]
  );

  expect(tvlAfterAllDeletes.rows[0].count).toBe("0");
});
