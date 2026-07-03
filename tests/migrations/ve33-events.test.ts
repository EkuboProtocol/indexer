import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00104_ve33_events",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  await client.close();
});

async function seedBlock(chainId: number, blockNumber: number) {
  await ensureIndexerCursor(client, chainId);
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 0)`,
    [
      chainId,
      blockNumber,
      `${chainId}${blockNumber}`,
      new Date("2026-06-29T00:00:00.000Z"),
    ],
  );
}

async function seedPoolKey(chainId: number) {
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
    [chainId, "1000", "2000", "3000", "4000", "0", "1000000", 64, "5000"],
  );

  return poolKeyId.toString();
}

test("ve33 event tables can reference known pools or keep raw pool ids", async () => {
  const chainId = 11155111;
  const blockNumber = 1;
  await seedBlock(chainId, blockNumber);
  const poolKeyId = await seedPoolKey(chainId);

  await client.query(
    `INSERT INTO ve33_vote_weight_applied (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        pool_id,
        owner,
        stake_id,
        stake_salt,
        stake_end_time,
        weight,
        swap_fee
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "9000",
      "6000",
      poolKeyId,
      "2000",
      "7000",
      "8000",
      "80",
      new Date("2027-01-01T00:00:00.000Z"),
      "123",
      "45",
    ],
  );

  await client.query(
    `INSERT INTO ve33_pool_fees_accounted (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        pool_id,
        amount0,
        amount1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [chainId, blockNumber, 0, 1, "9001", "6000", null, "9999", "5", "6"],
  );

  const { rows } = await client.query<{
    pool_key_id: string | null;
    pool_id: string;
  }>(
    `SELECT pool_key_id, pool_id
     FROM ve33_pool_fees_accounted
     WHERE chain_id = $1`,
    [chainId],
  );

  expect(rows).toEqual([{ pool_key_id: null, pool_id: "9999" }]);

  const { rows: voteRows } = await client.query<{ pool_key_id: string }>(
    `SELECT pool_key_id
     FROM ve33_vote_weight_applied
     WHERE chain_id = $1`,
    [chainId],
  );

  expect(voteRows.map((row) => String(row.pool_key_id))).toEqual([poolKeyId]);
});

test("deleting a block cascades ve33 event rows", async () => {
  const chainId = 11155112;
  const blockNumber = 2;
  await seedBlock(chainId, blockNumber);

  await client.query(
    `INSERT INTO ve33_stake_changed (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        owner,
        stake_id,
        stake_salt,
        stake_end_time,
        delta
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "9002",
      "6000",
      "7000",
      "8000",
      "80",
      new Date("2027-01-01T00:00:00.000Z"),
      "10",
    ],
  );

  await client.query(`DELETE FROM blocks WHERE chain_id = $1`, [chainId]);

  const {
    rows: [{ result }],
  } = await client.query<{ result: number }>(
    `SELECT count(1) AS result FROM ve33_stake_changed WHERE chain_id = $1`,
    [chainId],
  );

  expect(result).toBe(0);
});
