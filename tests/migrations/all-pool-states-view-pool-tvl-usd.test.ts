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

async function insertToken(
  chainId: bigint,
  tokenAddress: bigint,
  decimals: number
) {
  await client.query(
    `INSERT INTO erc20_tokens (
        chain_id, token_address, token_symbol, token_name, token_decimals,
        visibility_priority, sort_order
     ) VALUES ($1, $2, 'SYM', 'Token', $3, 1, 1)`,
    [chainId, tokenAddress, decimals]
  );
}

test("all_pool_states_view computes pool_tvl_usd from latest token prices", async () => {
  const chainId = 1n;
  const token0 = 1001n;
  const token1 = 1002n;

  await insertToken(chainId, token0, 18);
  await insertToken(chainId, token1, 6);

  const {
    rows: [{ pool_key_id }],
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
    [chainId, "2000", "3000", token0, token1, "10", "1000", 60, "0"]
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
    [pool_key_id, "100", 5, "200", 10, null]
  );

  await client.query(
    `INSERT INTO pool_tvl (pool_key_id, balance0, balance1)
     VALUES ($1, $2, $3)`,
    [pool_key_id, "2000000000000000000", "3000000"]
  );

  await client.query(
    `INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, source, "timestamp", value)
     VALUES
       ($1, $2, 'SRC', '2024-01-01T00:00:00Z', 1.5),
       ($1, $3, 'SRC', '2024-01-01T00:00:00Z', 2.0)`,
    [chainId, token0, token1]
  );

  const {
    rows: [row],
  } = await client.query<{ pool_tvl_usd: string }>(
    `SELECT pool_tvl_usd::text AS pool_tvl_usd
     FROM all_pool_states_view
     WHERE pool_key_id = $1`,
    [pool_key_id]
  );

  expect(row.pool_tvl_usd).toBe("9");
});

test("all_pool_states_view leaves pool_tvl_usd null when either latest price is missing", async () => {
  const chainId = 2n;
  const token0 = 2001n;
  const token1 = 2002n;

  await insertToken(chainId, token0, 18);
  await insertToken(chainId, token1, 18);

  const {
    rows: [{ pool_key_id }],
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
    [chainId, "2100", "3100", token0, token1, "10", "1000", 60, "0"]
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
    [pool_key_id, "150", 6, "300", 20, null]
  );

  await client.query(
    `INSERT INTO pool_tvl (pool_key_id, balance0, balance1)
     VALUES ($1, $2, $3)`,
    [pool_key_id, "1000000000000000000", "1000000000000000000"]
  );

  await client.query(
    `INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, source, "timestamp", value)
     VALUES ($1, $2, 'SRC', '2024-01-01T00:00:00Z', 4.0)`,
    [chainId, token0]
  );

  const {
    rows: [row],
  } = await client.query<{ pool_tvl_usd: string | null }>(
    `SELECT pool_tvl_usd::text AS pool_tvl_usd
     FROM all_pool_states_view
     WHERE pool_key_id = $1`,
    [pool_key_id]
  );

  expect(row.pool_tvl_usd).toBeNull();
});
