import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

let client: PGlite;

beforeAll(async () => {
  client = await createClient();
});

afterAll(async () => {
  await client.close();
});

test("limit-order pools surface in all_pool_states_view", async () => {
  const {
    rows: [{ pool_key_id: limitPoolKeyId }],
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
    [1, "1000", "2000", "3000", "4000", "10", "1000", 60, "6000"]
  );

  await client.query(
    `INSERT INTO pool_states (
        pool_key_id,
        sqrt_ratio,
        tick,
        liquidity,
        last_event_id,
        last_position_update_event_id
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [limitPoolKeyId, "100", 5, "200", 10, null]
  );

  await client.query(
    `INSERT INTO limit_order_pool_states (pool_key_id, last_event_id)
     VALUES ($1, $2)`,
    [limitPoolKeyId, 11]
  );

  const { rows: limitRows } = await client.query<{
    is_limit_order_pool: boolean;
  }>(
    `SELECT is_limit_order_pool
     FROM all_pool_states_view
     WHERE pool_key_id = $1`,
    [limitPoolKeyId]
  );

  expect(limitRows).toHaveLength(1);
  expect(limitRows[0].is_limit_order_pool).toBe(true);
});

test("regular pools still surface with is_limit_order_pool=false", async () => {
  const {
    rows: [{ pool_key_id: regularPoolKeyId }],
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
    [2, "1100", "2100", "3100", "4100", "10", "1000", 60, "0"]
  );

  await client.query(
    `INSERT INTO pool_states (
        pool_key_id,
        sqrt_ratio,
        tick,
        liquidity,
        last_event_id,
        last_position_update_event_id
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [regularPoolKeyId, "150", 6, "300", 20, null]
  );

  const { rows: regularRows } = await client.query<{
    pool_key_id: bigint;
    is_limit_order_pool: boolean;
  }>(
    `SELECT pool_key_id, is_limit_order_pool
     FROM all_pool_states_view
     WHERE pool_key_id = $1`,
    [regularPoolKeyId]
  );

  expect(regularRows).toHaveLength(1);
  expect(regularRows[0].is_limit_order_pool).toBe(false);
});
