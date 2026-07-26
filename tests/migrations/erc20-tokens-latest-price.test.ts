import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

async function insertToken(
  client: Client,
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

async function insertSource(
  client: Client,
  source: string,
  confidence: number,
  freshnessTime: string = "1 hour"
) {
  await client.query(
    `INSERT INTO erc20_token_price_sources (source, confidence, freshness_time)
     VALUES ($1, $2, $3::interval)
     ON CONFLICT (source) DO UPDATE
       SET confidence = excluded.confidence,
           freshness_time = excluded.freshness_time`,
    [source, confidence, freshnessTime]
  );
}

test("latest price uses the highest-confidence fresh source", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 123n;
    await insertToken(client, chainId, token);
    await insertSource(client, "LOW", 1);
    await insertSource(client, "TOP", 2);

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices
          (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'LOW', CURRENT_TIMESTAMP - INTERVAL '1 minute', 10),
              ($1, $2, 'TOP', CURRENT_TIMESTAMP - INTERVAL '2 minutes', 20)`,
      [chainId, token]
    );

    const {
      rows: [latest],
    } = await client.query<{ source: string; value: number; confidence: number }>(
      `SELECT source, value, confidence
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );

    expect(latest).toEqual({ source: "TOP", value: 20, confidence: 2 });
  } finally {
    await client.close();
  }
});

test("lower-confidence observations do not rewrite the effective price", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 234n;
    await insertToken(client, chainId, token);
    await insertSource(client, "LOW", 1);
    await insertSource(client, "TOP", 2);

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices
          (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'TOP', CURRENT_TIMESTAMP, 20)`,
      [chainId, token]
    );
    const {
      rows: [{ ctid: beforeCtid }],
    } = await client.query<{ ctid: string }>(
      `SELECT ctid::text
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices
          (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'LOW', CURRENT_TIMESTAMP, 10)`,
      [chainId, token]
    );
    const {
      rows: [{ ctid: afterCtid }],
    } = await client.query<{ ctid: string }>(
      `SELECT ctid::text
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );

    expect(afterCtid).toBe(beforeCtid);
  } finally {
    await client.close();
  }
});

test("latest price averages all fresh values tied at maximum confidence", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 456n;
    await insertToken(client, chainId, token);
    await insertSource(client, "ONE", 5);
    await insertSource(client, "TWO", 5);
    await insertSource(client, "LOW", 4);

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices
          (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'ONE', CURRENT_TIMESTAMP - INTERVAL '3 minutes', 10),
              ($1, $2, 'TWO', CURRENT_TIMESTAMP - INTERVAL '2 minutes', 14),
              ($1, $2, 'LOW', CURRENT_TIMESTAMP - INTERVAL '1 minute', 100)`,
      [chainId, token]
    );

    const {
      rows: [latest],
    } = await client.query<{ source: string; value: number; confidence: number }>(
      `SELECT source, value, confidence
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );

    expect(latest).toEqual({ source: "AVG", value: 12, confidence: 5 });
  } finally {
    await client.close();
  }
});

test("stale sources are excluded before selecting maximum confidence", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 789n;
    await insertToken(client, chainId, token);
    await insertSource(client, "OLD", 10, "5 minutes");
    await insertSource(client, "NEW", 1, "5 minutes");

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices
          (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'OLD', CURRENT_TIMESTAMP - INTERVAL '6 minutes', 100),
              ($1, $2, 'NEW', CURRENT_TIMESTAMP - INTERVAL '1 minute', 7)`,
      [chainId, token]
    );

    const {
      rows: [latest],
    } = await client.query<{ source: string; value: number; confidence: number }>(
      `SELECT source, value, confidence
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );

    expect(latest).toEqual({ source: "NEW", value: 7, confidence: 1 });
  } finally {
    await client.close();
  }
});

test("tokens with no fresh source have no latest price", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 101112n;
    await insertToken(client, chainId, token);
    await insertSource(client, "OLD", 1, "5 minutes");

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices
          (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'OLD', CURRENT_TIMESTAMP - INTERVAL '6 minutes', 100)`,
      [chainId, token]
    );

    const { rows } = await client.query(
      `SELECT 1
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );
    expect(rows).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test("expiration refresh promotes the next fresh confidence tier", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 111213n;
    await insertToken(client, chainId, token);
    await insertSource(client, "TOP", 2, "5 minutes");
    await insertSource(client, "LOW", 1, "1 hour");

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices
          (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'TOP', CURRENT_TIMESTAMP - INTERVAL '4 minutes', 20),
              ($1, $2, 'LOW', CURRENT_TIMESTAMP, 10)`,
      [chainId, token]
    );

    const {
      rows: [beforeExpiration],
    } = await client.query<{ source: string; value: number }>(
      `SELECT source, value
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );
    expect(beforeExpiration).toEqual({ source: "TOP", value: 20 });

    await client.query(
      `SELECT refresh_expired_erc20_token_latest_prices(
          CURRENT_TIMESTAMP + INTERVAL '2 minutes'
       )`
    );

    const {
      rows: [afterExpiration],
    } = await client.query<{ source: string; value: number }>(
      `SELECT source, value
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );
    expect(afterExpiration).toEqual({ source: "LOW", value: 10 });
  } finally {
    await client.close();
  }
});

test("cache tracks only the latest observation from each source", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 131415n;
    await insertToken(client, chainId, token);
    await insertSource(client, "SRC", 1);

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices
          (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'SRC', CURRENT_TIMESTAMP - INTERVAL '2 minutes', 1),
              ($1, $2, 'SRC', CURRENT_TIMESTAMP - INTERVAL '1 minute', 2.5)`,
      [chainId, token]
    );

    const {
      rows: [latest],
    } = await client.query<{ value: number }>(
      `SELECT value
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );
    const {
      rows: [cacheCount],
    } = await client.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM erc20_tokens_latest_price_by_source
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );

    expect(latest.value).toBe(2.5);
    expect(cacheCount.count).toBe(1);
  } finally {
    await client.close();
  }
});

test("deleting a source's latest observation backfills that source", async () => {
  const client = await createClient();
  try {
    const chainId = 1n;
    const token = 161718n;
    await insertToken(client, chainId, token);
    await insertSource(client, "SRC", 1);

    await client.query(
      `INSERT INTO erc20_tokens_usd_prices
          (chain_id, token_address, source, "timestamp", value)
       VALUES ($1, $2, 'SRC', CURRENT_TIMESTAMP - INTERVAL '2 minutes', 1),
              ($1, $2, 'SRC', CURRENT_TIMESTAMP - INTERVAL '1 minute', 2)`,
      [chainId, token]
    );

    await client.query(
      `DELETE FROM erc20_tokens_usd_prices
       WHERE chain_id = $1
         AND token_address = $2
         AND source = 'SRC'
         AND value = 2`,
      [chainId, token]
    );

    const {
      rows: [latestAfterDelete],
    } = await client.query<{ value: number }>(
      `SELECT value
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );
    expect(latestAfterDelete.value).toBe(1);

    await client.query(
      `DELETE FROM erc20_tokens_usd_prices
       WHERE chain_id = $1 AND token_address = $2 AND source = 'SRC'`,
      [chainId, token]
    );

    const { rows } = await client.query(
      `SELECT 1
       FROM erc20_tokens_latest_price
       WHERE chain_id = $1 AND token_address = $2`,
      [chainId, token]
    );
    expect(rows).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test("source policy uses compact bounded types without widening history", async () => {
  const client = await createClient();
  try {
    const { rows: sourceColumns } = await client.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'erc20_token_price_sources'
       ORDER BY ordinal_position`
    );
    const { rows: historyColumns } = await client.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'erc20_tokens_usd_prices'
       ORDER BY ordinal_position`
    );

    expect(sourceColumns.map(({ column_name }) => column_name)).toEqual([
      "source",
      "freshness_time",
      "confidence",
    ]);
    expect(historyColumns.map(({ column_name }) => column_name)).not.toContain(
      "freshness_time"
    );
    expect(historyColumns.map(({ column_name }) => column_name)).not.toContain(
      "confidence"
    );

    await expect(
      client.query(
        `INSERT INTO erc20_token_price_sources
            (source, freshness_time, confidence)
         VALUES ('BAD', INTERVAL '1 minute', 256)`
      )
    ).rejects.toThrow();
  } finally {
    await client.close();
  }
});

test("quoter price reads retain the physical primary-key lookup plan", async () => {
  const client = await createClient();
  try {
    const {
      rows: [{ table_type }],
    } = await client.query<{ table_type: string }>(
      `SELECT table_type
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'erc20_tokens_latest_price'`
    );
    const { rows } = await client.query<Record<string, string>>(
      `EXPLAIN
       SELECT t.token_address, t.token_decimals, p.value
       FROM erc20_tokens t
                JOIN erc20_tokens_latest_price p USING (chain_id, token_address)
       WHERE t.chain_id = 1`
    );
    const plan = rows.map((row) => Object.values(row)[0]).join("\n");

    expect(table_type).toBe("BASE TABLE");
    expect(plan).toContain("erc20_tokens_latest_price_pkey");
    expect(plan).not.toContain("WindowAgg");
    expect(plan).not.toContain("GroupAggregate");
  } finally {
    await client.close();
  }
});
