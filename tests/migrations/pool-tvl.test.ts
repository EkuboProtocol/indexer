import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "001_chain_tables.sql",
  "002_core_tables.sql",
  "011_pool_tvl.sql",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  await client.close();
});

async function seedBlock({
  chainId,
  blockNumber,
}: {
  chainId: number;
  blockNumber: number;
}) {
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
     VALUES ($1, $2, $3, $4)`,
    [
      chainId,
      blockNumber,
      `${chainId}${blockNumber}`,
      new Date("2024-01-01T00:00:00Z"),
    ]
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
    [chainId, "1000", "2000", "3000", "3001", "25", "1000000", 60, "4000"]
  );

  return Number(poolKeyId);
}

async function getPoolTvl(poolKeyId: number) {
  const { rows } = await client.query<{ balance0: string; balance1: string }>(
    `SELECT balance0, balance1 FROM pool_tvl WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  return rows[0];
}

test("deleting blocks cascades pool_balance_change rows and restores pool_tvl", async () => {
  const chainId = 330;
  const baseBlock = 7100;
  const reorgBlock = 7101;

  await seedBlock({ chainId, blockNumber: baseBlock });
  await seedBlock({ chainId, blockNumber: reorgBlock });
  const poolKeyId = await insertPoolKey(chainId);

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
      baseBlock,
      0,
      0,
      "5000",
      "6000",
      poolKeyId,
      "7000",
      "125.5",
      "-64.25",
      "1500",
      20,
      "900",
    ]
  );

  let tvl = await getPoolTvl(poolKeyId);
  expect(Number(tvl.balance0)).toEqual(125.5);
  expect(Number(tvl.balance1)).toEqual(-64.25);

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
      reorgBlock,
      0,
      0,
      "5001",
      "6001",
      poolKeyId,
      "7001",
      "-30.75",
      "12.5",
      "1800",
      24,
      "1100",
    ]
  );

  tvl = await getPoolTvl(poolKeyId);
  expect(tvl).toMatchObject({
    balance0: "94.75",
    balance1: "-51.75",
  });

  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, reorgBlock]
  );

  tvl = await getPoolTvl(poolKeyId);
  expect(Number(tvl.balance0)).toEqual(125.5);
  expect(Number(tvl.balance1)).toEqual(-64.25);

  const { rows: remainingBalanceChanges } = await client.query(
    `SELECT 1
     FROM pool_balance_change
     WHERE chain_id = $1 AND block_number = $2`,
    [chainId, reorgBlock]
  );
  expect(remainingBalanceChanges.length).toBe(0);
});
