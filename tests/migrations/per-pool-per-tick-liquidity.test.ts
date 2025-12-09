import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00005_per_pool_per_tick_liquidity",
  "00060_pool_config_v2",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  await client.close();
});

async function seedBlock(chainId: number, blockNumber: number) {
  const blockHash = `${chainId}${blockNumber}${Date.now()}`;
  const blockTime = new Date("2024-01-01T00:00:00Z");

  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
     VALUES ($1, $2, $3, $4)`,
    [chainId, blockNumber, blockHash, blockTime]
  );
}

async function insertPoolKey(chainId: number) {
  const {
    rows: [{ pool_key_id: poolKeyId }],
  } = await client.query<{ pool_key_id: bigint }>(
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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING pool_key_id`,
    [chainId, "1000", "2000", "1", "2", "10", "1000", 60, "5000"]
  );

  return poolKeyId;
}

async function insertPositionUpdate({
  chainId,
  blockNumber,
  transactionIndex,
  eventIndex,
  poolKeyId,
  lowerBound,
  upperBound,
  liquidityDelta,
}: {
  chainId: number;
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  poolKeyId: bigint;
  lowerBound: number;
  upperBound: number;
  liquidityDelta: string;
}) {
  const {
    rows: [{ event_id: eventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO position_updates (
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
        liquidity_delta,
        delta0,
        delta1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      transactionIndex,
      eventIndex,
      `${blockNumber}${transactionIndex}${eventIndex}`,
      "999",
      poolKeyId.toString(),
      "777",
      `${transactionIndex}${eventIndex}`,
      lowerBound,
      upperBound,
      liquidityDelta,
      "0",
      "0",
    ]
  );

  return eventId;
}

test("position inserts update per_pool_per_tick_liquidity rows", async () => {
  const chainId = 201;
  const blockNumber = 5001;
  const lowerBound = -120;
  const upperBound = 180;
  const liquidityDelta = "1500";

  await seedBlock(chainId, blockNumber);
  const poolKeyId = await insertPoolKey(chainId);
  await insertPositionUpdate({
    chainId,
    blockNumber,
    transactionIndex: 0,
    eventIndex: 0,
    poolKeyId,
    lowerBound,
    upperBound,
    liquidityDelta,
  });

  const { rows } = await client.query<{
    tick: number;
    net_liquidity_delta_diff: string;
    total_liquidity_on_tick: string;
  }>(
    `SELECT tick, net_liquidity_delta_diff, total_liquidity_on_tick
     FROM per_pool_per_tick_liquidity
     WHERE pool_key_id = $1
     ORDER BY tick ASC`,
    [poolKeyId.toString()]
  );

  expect(rows).toEqual([
    {
      tick: lowerBound,
      net_liquidity_delta_diff: liquidityDelta,
      total_liquidity_on_tick: liquidityDelta,
    },
    {
      tick: upperBound,
      net_liquidity_delta_diff: `-${liquidityDelta}`,
      total_liquidity_on_tick: liquidityDelta,
    },
  ]);
});

test("position deletes adjust per_pool_per_tick_liquidity aggregates", async () => {
  const chainId = 202;
  const blockNumber = 5002;
  const lowerBound = -60;
  const upperBound = 120;

  await seedBlock(chainId, blockNumber);
  const poolKeyId = await insertPoolKey(chainId);

  const firstLiquidity = "100";
  const secondLiquidity = "250";

  const firstEventId = await insertPositionUpdate({
    chainId,
    blockNumber,
    transactionIndex: 0,
    eventIndex: 0,
    poolKeyId,
    lowerBound,
    upperBound,
    liquidityDelta: firstLiquidity,
  });

  const secondEventId = await insertPositionUpdate({
    chainId,
    blockNumber,
    transactionIndex: 0,
    eventIndex: 1,
    poolKeyId,
    lowerBound,
    upperBound,
    liquidityDelta: secondLiquidity,
  });

  const summedLiquidity = (
    BigInt(firstLiquidity) + BigInt(secondLiquidity)
  ).toString();

  const afterInsert = await client.query<{
    tick: number;
    net_liquidity_delta_diff: string;
    total_liquidity_on_tick: string;
  }>(
    `SELECT tick, net_liquidity_delta_diff, total_liquidity_on_tick
     FROM per_pool_per_tick_liquidity
     WHERE pool_key_id = $1
     ORDER BY tick ASC`,
    [poolKeyId.toString()]
  );

  expect(afterInsert.rows).toEqual([
    {
      tick: lowerBound,
      net_liquidity_delta_diff: summedLiquidity,
      total_liquidity_on_tick: summedLiquidity,
    },
    {
      tick: upperBound,
      net_liquidity_delta_diff: `-${summedLiquidity}`,
      total_liquidity_on_tick: summedLiquidity,
    },
  ]);

  await client.query(
    `DELETE FROM position_updates WHERE chain_id = $1 AND event_id = $2`,
    [chainId, firstEventId.toString()]
  );

  const afterFirstDelete = await client.query<{
    tick: number;
    net_liquidity_delta_diff: string;
    total_liquidity_on_tick: string;
  }>(
    `SELECT tick, net_liquidity_delta_diff, total_liquidity_on_tick
     FROM per_pool_per_tick_liquidity
     WHERE pool_key_id = $1
     ORDER BY tick ASC`,
    [poolKeyId.toString()]
  );

  expect(afterFirstDelete.rows).toEqual([
    {
      tick: lowerBound,
      net_liquidity_delta_diff: secondLiquidity,
      total_liquidity_on_tick: secondLiquidity,
    },
    {
      tick: upperBound,
      net_liquidity_delta_diff: `-${secondLiquidity}`,
      total_liquidity_on_tick: secondLiquidity,
    },
  ]);

  await client.query(
    `DELETE FROM position_updates WHERE chain_id = $1 AND event_id = $2`,
    [chainId, secondEventId.toString()]
  );

  const afterSecondDelete = await client.query<{
    tick: number;
    net_liquidity_delta_diff: string;
    total_liquidity_on_tick: string;
  }>(
    `SELECT tick, net_liquidity_delta_diff, total_liquidity_on_tick
     FROM per_pool_per_tick_liquidity
     WHERE pool_key_id = $1`,
    [poolKeyId.toString()]
  );

  expect(afterSecondDelete.rows).toHaveLength(0);
});

test("deleting blocks cascades position updates and rewinds tick liquidity state", async () => {
  const chainId = 204;
  const firstBlock = 6100;
  const secondBlock = 6101;
  const lowerBound = -40;
  const upperBound = 80;

  await seedBlock(chainId, firstBlock);
  await seedBlock(chainId, secondBlock);
  const poolKeyId = await insertPoolKey(chainId);

  const firstDelta = "500";
  await insertPositionUpdate({
    chainId,
    blockNumber: firstBlock,
    transactionIndex: 0,
    eventIndex: 0,
    poolKeyId,
    lowerBound,
    upperBound,
    liquidityDelta: firstDelta,
  });

  const secondDelta = "175";
  await insertPositionUpdate({
    chainId,
    blockNumber: secondBlock,
    transactionIndex: 0,
    eventIndex: 0,
    poolKeyId,
    lowerBound,
    upperBound,
    liquidityDelta: secondDelta,
  });

  const combinedDelta = (BigInt(firstDelta) + BigInt(secondDelta)).toString();

  const beforeDelete = await client.query<{
    tick: number;
    net_liquidity_delta_diff: string;
    total_liquidity_on_tick: string;
  }>(
    `SELECT tick, net_liquidity_delta_diff, total_liquidity_on_tick
     FROM per_pool_per_tick_liquidity
     WHERE pool_key_id = $1
     ORDER BY tick ASC`,
    [poolKeyId.toString()]
  );

  expect(beforeDelete.rows).toEqual([
    {
      tick: lowerBound,
      net_liquidity_delta_diff: combinedDelta,
      total_liquidity_on_tick: combinedDelta,
    },
    {
      tick: upperBound,
      net_liquidity_delta_diff: `-${combinedDelta}`,
      total_liquidity_on_tick: combinedDelta,
    },
  ]);

  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, secondBlock]
  );

  const afterDelete = await client.query<{
    tick: number;
    net_liquidity_delta_diff: string;
    total_liquidity_on_tick: string;
  }>(
    `SELECT tick, net_liquidity_delta_diff, total_liquidity_on_tick
     FROM per_pool_per_tick_liquidity
     WHERE pool_key_id = $1
     ORDER BY tick ASC`,
    [poolKeyId.toString()]
  );

  expect(afterDelete.rows).toEqual([
    {
      tick: lowerBound,
      net_liquidity_delta_diff: firstDelta,
      total_liquidity_on_tick: firstDelta,
    },
    {
      tick: upperBound,
      net_liquidity_delta_diff: `-${firstDelta}`,
      total_liquidity_on_tick: firstDelta,
    },
  ]);

  const { rows: remainingPositionUpdates } = await client.query(
    `SELECT 1
     FROM position_updates
     WHERE chain_id = $1 AND block_number = $2`,
    [chainId, secondBlock]
  );
  expect(remainingPositionUpdates.length).toBe(0);
});

test("position_updates rows cannot be updated", async () => {
  const chainId = 203;
  const blockNumber = 5003;
  const lowerBound = 30;
  const upperBound = 90;

  await seedBlock(chainId, blockNumber);
  const poolKeyId = await insertPoolKey(chainId);

  const eventId = await insertPositionUpdate({
    chainId,
    blockNumber,
    transactionIndex: 0,
    eventIndex: 0,
    poolKeyId,
    lowerBound,
    upperBound,
    liquidityDelta: "400",
  });

  await expect(
    client.query(
      `UPDATE position_updates
       SET liquidity_delta = $1
       WHERE chain_id = $2 AND event_id = $3`,
      ["500", chainId, eventId.toString()]
    )
  ).rejects.toThrow(/Updates are not allowed on position_updates/);
});
