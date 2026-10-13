import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

const AS_OF = "2026-10-13 12:00:00+00";

async function setup(client: Client) {
  await client.query(
    `INSERT INTO erc20_tokens (
        chain_id, token_address, token_symbol, token_name, token_decimals,
        visibility_priority, sort_order
     ) VALUES (1, 1, 'A', 'A', 18, 1, 1), (1, 2, 'B', 'B', 18, 1, 1)`,
  );
}

async function insertPrice(
  client: Client,
  token: number,
  timestamp: string,
  source: string,
  value: number,
  validUntil: string | null = null,
) {
  await client.query(
    `INSERT INTO erc20_tokens_usd_prices
        (chain_id, token_address, "timestamp", source, value, valid_until)
     VALUES (1, $1, $2, $3, $4, $5)`,
    [token, timestamp, source, value, validUntil],
  );
}

async function hourly(client: Client) {
  const { rows } = await client.query<{
    token_address: string;
    hour: string;
    timestamp: string;
    source: string;
    value: number;
  }>(
    `SELECT token_address::TEXT,
            to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS hour,
            to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS "timestamp",
            source,
            value
     FROM erc20_tokens_usd_prices_hourly
     ORDER BY token_address, hour`,
  );
  return rows;
}

async function rawCount(client: Client) {
  const { rows } = await client.query<{ n: number }>(
    `SELECT COUNT(*)::INT AS n FROM erc20_tokens_usd_prices`,
  );
  return rows[0].n;
}

async function prune(client: Client, asOf = AS_OF) {
  const { rows } = await client.query<{ pruned: string }>(
    `SELECT prune_erc20_tokens_usd_prices($1)::TEXT AS pruned`,
    [asOf],
  );
  return Number(rows[0].pruned);
}

test("pruning folds each token's latest observation per hour into the hourly table", async () => {
  const client = await createClient();
  try {
    await setup(client);
    // A session time zone with a half-hour offset must not move the hours.
    await client.query(`SET TIME ZONE 'Asia/Kolkata'`);

    await insertPrice(client, 1, "2026-10-12 09:10:00+00", "ss1", 10);
    await insertPrice(client, 1, "2026-10-12 09:50:00+00", "cg1", 11);
    await insertPrice(client, 1, "2026-10-12 09:50:00+00", "qp1", 12);
    await insertPrice(client, 1, "2026-10-12 10:20:00+00", "ss1", 13);
    await insertPrice(client, 2, "2026-10-12 09:30:00+00", "cl1", 20);
    // Inside the one-day window: stays raw.
    await insertPrice(client, 1, "2026-10-12 12:30:00+00", "ss1", 14);

    expect(await prune(client)).toBe(5);
    expect(await rawCount(client)).toBe(1);
    expect(await hourly(client)).toEqual([
      {
        token_address: "1",
        hour: "2026-10-12 09:00",
        timestamp: "2026-10-12 09:50",
        source: "qp1",
        value: 12,
      },
      {
        token_address: "1",
        hour: "2026-10-12 10:00",
        timestamp: "2026-10-12 10:20",
        source: "ss1",
        value: 13,
      },
      {
        token_address: "2",
        hour: "2026-10-12 09:00",
        timestamp: "2026-10-12 09:30",
        source: "cl1",
        value: 20,
      },
    ]);
  } finally {
    await client.close();
  }
});

test("observations retained while valid fold in later and only replace earlier ones", async () => {
  const client = await createClient();
  try {
    await setup(client);

    await insertPrice(client, 1, "2026-10-12 09:10:00+00", "ss1", 10);
    // Still valid at the first prune, so retention keeps it.
    await insertPrice(
      client,
      1,
      "2026-10-12 09:40:00+00",
      "cl1",
      11,
      "2026-10-13 15:00:00+00",
    );

    expect(await prune(client)).toBe(1);
    expect((await hourly(client)).map((r) => r.value)).toEqual([10]);

    expect(await prune(client, "2026-10-13 16:00:00+00")).toBe(1);
    expect(await rawCount(client)).toBe(0);
    expect(await hourly(client)).toEqual([
      {
        token_address: "1",
        hour: "2026-10-12 09:00",
        timestamp: "2026-10-12 09:40",
        source: "cl1",
        value: 11,
      },
    ]);

    // A late, earlier observation does not overwrite the hour's latest.
    await insertPrice(client, 1, "2026-10-12 09:20:00+00", "cg1", 99);
    expect(await prune(client, "2026-10-13 16:00:00+00")).toBe(1);
    expect((await hourly(client)).map((r) => r.value)).toEqual([11]);
  } finally {
    await client.close();
  }
});

test("hourly history is kept for 31 days", async () => {
  const client = await createClient();
  try {
    await setup(client);

    await insertPrice(client, 1, "2026-09-11 11:30:00+00", "ss1", 1);
    await insertPrice(client, 1, "2026-09-12 12:30:00+00", "ss1", 2);
    await prune(client);

    expect((await hourly(client)).map((r) => r.value)).toEqual([2]);
  } finally {
    await client.close();
  }
});
