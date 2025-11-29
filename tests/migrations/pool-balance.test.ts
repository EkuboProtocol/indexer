import { beforeAll, test, expect, afterAll } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00060_pool_config_v2",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  await client.close();
});

async function seedPool(client: PGlite, chainId: number) {
  const blockNumber = 100;
  const blockHash = "1001";
  const blockTime = new Date("2024-01-01T00:00:00Z");

  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
     VALUES ($1, $2, $3, $4)`,
    [chainId, blockNumber, blockHash, blockTime]
  );

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
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING pool_key_id`,
    [chainId, "2000", "3000", "4000", "4001", "100", "1000000", 60, "5000"]
  );

  return { chainId, blockNumber, poolKeyId: Number(poolKeyId) };
}

test("swap insert creates matching pool_balance_change row", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, 1);

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
      1,
      2,
      "6000",
      "7000",
      poolKeyId,
      "8000",
      "-123.45",
      "678.90",
      "9101112",
      15,
      "100000",
    ]
  );

  const {
    rows: [{ event_id: eventId }],
  } = await client.query<{ event_id: bigint }>(
    `SELECT event_id FROM swaps WHERE chain_id = $1 AND block_number = $2`,
    [chainId, blockNumber]
  );

  const { rows } = await client.query(
    `SELECT delta0, delta1 FROM pool_balance_change WHERE chain_id = $1 AND event_id = $2`,
    [chainId, eventId]
  );

  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({
    delta0: "-123.45",
    delta1: "678.90",
  });
});

test("position_updates insert mirrors liquidity delta in pool_balance_change", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, 2);

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
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      1,
      "6100",
      "7100",
      poolKeyId,
      "8100",
      "9100",
      -100,
      100,
      "5000",
      "321.00",
      "-654.00",
    ]
  );

  const { rows } = await client.query(
    `SELECT delta0, delta1 FROM pool_balance_change WHERE chain_id = $1 AND event_id = $2`,
    [chainId, eventId]
  );

  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({
    delta0: "321.00",
    delta1: "-654.00",
  });
});

test("inserts into multiple tables create separate pool_balance_change rows", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, 3);

  const {
    rows: [{ event_id: swapEventId }],
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
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING event_id`,
    [
      chainId,
      blockNumber,
      1,
      1,
      "6200",
      "7200",
      poolKeyId,
      "8200",
      "-10",
      "5",
      "111111",
      20,
      "200000",
    ]
  );

  const {
    rows: [{ event_id: positionEventId }],
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
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING event_id`,
    [
      chainId,
      blockNumber,
      1,
      2,
      "6300",
      "7300",
      poolKeyId,
      "8300",
      "9300",
      -200,
      200,
      "6000",
      "20",
      "-7",
    ]
  );

  const { rows } = await client.query(
    `SELECT event_id, delta0, delta1 FROM pool_balance_change WHERE chain_id = $1 ORDER BY event_id`,
    [chainId]
  );

  expect(rows.length).toBe(2);
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event_id: swapEventId,
        delta0: "-10",
        delta1: "5",
      }),
      expect.objectContaining({
        event_id: positionEventId,
        delta0: "20",
        delta1: "-7",
      }),
    ])
  );
});

test("deleting a source row removes its pool_balance_change entry", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, 4);

  const {
    rows: [{ event_id: eventId }],
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
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING event_id`,
    [
      chainId,
      blockNumber,
      2,
      3,
      "6400",
      "7400",
      poolKeyId,
      "8400",
      "-15",
      "9",
      "121212",
      25,
      "300000",
    ]
  );

  await client.query(
    `DELETE FROM swaps WHERE chain_id = $1 AND event_id = $2`,
    [chainId, eventId]
  );

  const { rows } = await client.query(
    `SELECT 1 FROM pool_balance_change WHERE chain_id = $1 AND event_id = $2`,
    [chainId, eventId]
  );

  expect(rows.length).toBe(0);
});
