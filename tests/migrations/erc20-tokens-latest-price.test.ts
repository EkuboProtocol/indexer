import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

async function insertToken(
  client: Awaited<ReturnType<typeof createClient>>,
  chainId: bigint,
  tokenAddress: bigint
) {
  await client.query(
    `INSERT INTO erc20_tokens (
        chain_id, token_address, token_symbol, token_name, token_decimals,
        visibility_priority, sort_order
     ) VALUES ($1, $2, 'SYM', 'Token', 18, 1, 1)`,
    [chainId, tokenAddress]
  );
}

test("insert trigger tracks latest price by chain/token", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 123n;

    await insertToken(client, chainId, token);

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'SRC', '2024-01-01T00:00:00Z', 1.0)`,
      [chainId, token]
    );

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'SRC', '2024-01-02T00:00:00Z', 2.5)`,
      [chainId, token]
    );

    const {
      rows: [latest],
    } = await client.query<{
      chain_id: string;
      token_address: string;
      source: string;
      timestamp: string;
      value: string;
    }>(
      `SELECT chain_id::text,
              token_address::text,
              source,
              "timestamp"::text AS timestamp,
              value::text
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );

    expect(latest).toEqual({
      chain_id: chainId.toString(),
      token_address: token.toString(),
      source: "SRC",
      timestamp: "2024-01-02 00:00:00+00",
      value: "2.5",
    });
  } finally {
    await client.close();
  }
});

test("equal-timestamp insert replaces latest value and source", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 456n;
    const ts = "2024-01-01T00:00:00Z";

    await insertToken(client, chainId, token);

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'SRC', $3, 1.0)`,
      [chainId, token, ts]
    );
    await client.query(
      `INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'ALT', $3, 3.0)`,
      [chainId, token, ts]
    );

    const {
      rows: [latest],
    } = await client.query<{
      source: string;
      value: string;
    }>(
      `SELECT source, value::text
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );

    expect(latest).toEqual({ source: "ALT", value: "3" });
  } finally {
    await client.close();
  }
});

test("delete trigger backfills the next-latest price", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 789n;

    await insertToken(client, chainId, token);

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'SRC', '2024-01-01T00:00:00Z', 1.0),
              ($1, $2, 'SRC', '2024-01-02T00:00:00Z', 2.0)`,
      [chainId, token]
    );

    await client.query(
      `DELETE FROM erc20_tokens_usd_prices
       WHERE chain_id = $1 AND token_address = $2 AND "timestamp" = '2024-01-02T00:00:00Z'`,
      [chainId, token]
    );

    const {
      rows: [latestAfterDelete],
    } = await client.query<{
      timestamp: string;
      value: string;
    }>(
      `SELECT "timestamp"::text AS timestamp, value::text
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );

    expect(latestAfterDelete).toEqual({
      timestamp: "2024-01-01 00:00:00+00",
      value: "1",
    });

    await client.query(
      `DELETE FROM erc20_tokens_usd_prices
       WHERE chain_id = $1 AND token_address = $2 AND "timestamp" = '2024-01-01T00:00:00Z'`,
      [chainId, token]
    );

    const { rows: remainingRows } = await client.query(
      `SELECT 1 FROM erc20_tokens_latest_price WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );
    expect(remainingRows.length).toBe(0);
  } finally {
    await client.close();
  }
});

test("deleting non-latest price leaves latest untouched", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 101112n;

    await insertToken(client, chainId, token);

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'SRC', '2024-01-01T00:00:00Z', 1.0),
              ($1, $2, 'SRC', '2024-01-03T00:00:00Z', 3.0)`,
      [chainId, token]
    );

    await client.query(
      `DELETE FROM erc20_tokens_usd_prices
       WHERE chain_id = $1 AND token_address = $2 AND "timestamp" = '2024-01-01T00:00:00Z'`,
      [chainId, token]
    );

    const {
      rows: [latest],
    } = await client.query<{
      timestamp: string;
      value: string;
    }>(
      `SELECT "timestamp"::text AS timestamp, value::text
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );

    expect(latest).toEqual({
      timestamp: "2024-01-03 00:00:00+00",
      value: "3",
    });
  } finally {
    await client.close();
  }
});
