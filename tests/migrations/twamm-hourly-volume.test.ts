import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createClient,
  ensureIndexerCursor,
  runMigrationsThrough,
} from "../helpers/db.js";

type Client = PGlite;

const CHAIN_ID = 9;
const TOKEN0 = "4000";
const TOKEN1 = "4001";
const TWAMM = "6000";
const ROUTER = "3000";
const T0 = Date.parse("2024-01-01T00:00:00Z") / 1000;
const MINUTE = 60;
const HOUR = 3600;
const X32 = 1n << 32n;
const MIN_EVENT_ID = "-9223372036854775808";

const at = (seconds: number) => new Date((T0 + seconds) * 1000);
const hour = (h: number) => at(h * HOUR).toISOString();

async function block(client: Client, blockNumber: number, seconds: number) {
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 1)`,
    [CHAIN_ID, blockNumber, String(blockNumber), at(seconds)],
  );
}

async function seedPool(client: Client) {
  await ensureIndexerCursor(client, CHAIN_ID);
  const {
    rows: [{ pool_key_id }],
  } = await client.query<{ pool_key_id: string }>(
    `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
                            fee_denominator, tick_spacing, pool_extension)
     VALUES ($1, 2000, 1, $2, $3, 10, 1000, 60, $4)
     RETURNING pool_key_id`,
    [CHAIN_ID, TOKEN0, TOKEN1, TWAMM],
  );
  return Number(pool_key_id);
}

async function voe(
  client: Client,
  pool: number,
  blockNumber: number,
  tx: number,
  logIndex: number,
  rate0: bigint,
  rate1: bigint,
) {
  await client.query(
    `INSERT INTO twamm_virtual_order_executions (chain_id, block_number, transaction_index, event_index,
                                                 transaction_hash, emitter, pool_key_id,
                                                 token0_sale_rate, token1_sale_rate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [CHAIN_ID, blockNumber, tx, logIndex, String(blockNumber * 100 + tx), TWAMM, pool, rate0.toString(), rate1.toString()],
  );
}

async function orderUpdate(
  client: Client,
  pool: number,
  blockNumber: number,
  tx: number,
  logIndex: number,
  salt: number,
  startSeconds: number,
  endSeconds: number,
  delta0: bigint,
  delta1: bigint,
) {
  await client.query(
    `INSERT INTO twamm_order_updates (chain_id, block_number, transaction_index, event_index,
                                      transaction_hash, emitter, pool_key_id, locker, salt,
                                      sale_rate_delta0, sale_rate_delta1, start_time, end_time,
                                      is_selling_token1)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 7000, $8, $9, $10, $11, $12, $13)`,
    [
      CHAIN_ID,
      blockNumber,
      tx,
      logIndex,
      String(blockNumber * 100 + tx),
      TWAMM,
      pool,
      salt,
      delta0.toString(),
      delta1.toString(),
      at(startSeconds),
      at(endSeconds),
      delta1 !== 0n,
    ],
  );
}

async function swap(
  client: Client,
  pool: number,
  blockNumber: number,
  tx: number,
  logIndex: number,
  locker: string,
  delta0: bigint,
  delta1: bigint,
) {
  await client.query(
    `INSERT INTO swaps (chain_id, block_number, transaction_index, event_index, transaction_hash,
                        emitter, pool_key_id, locker, delta0, delta1, sqrt_ratio_after, tick_after,
                        liquidity_after)
     VALUES ($1, $2, $3, $4, $5, 2000, $6, $7, $8, $9, 1, 0, 1000)`,
    [CHAIN_ID, blockNumber, tx, logIndex, String(blockNumber * 100 + tx), pool, locker, delta0.toString(), delta1.toString()],
  );
}

// Inserted in log order, as the processors do.
async function block1(client: Client, pool: number) {
  // Pool initialization at 00:00 emits a VOE with zero sale rates.
  await block(client, 1, 0);
  await client.query(
    `INSERT INTO pool_initializations (chain_id, block_number, transaction_index, event_index,
                                       transaction_hash, emitter, pool_key_id, tick, sqrt_ratio)
     VALUES ($1, 1, 0, 0, 100, 2000, $2, 0, 1)`,
    [CHAIN_ID, pool],
  );
  await voe(client, pool, 1, 0, 1, 0n, 0n);
}

async function block2(client: Client, pool: number) {
  // 00:30 order A sells 10 token0/s from now until 03:00; order B sells
  // 3 token1/s from 01:00 to 02:30.
  await block(client, 2, 30 * MINUTE);
  await voe(client, pool, 2, 0, 0, 0n, 0n);
  await orderUpdate(client, pool, 2, 0, 1, 1, 30 * MINUTE, 3 * HOUR, 10n * X32, 0n);
  await orderUpdate(client, pool, 2, 1, 0, 2, HOUR, 2.5 * HOUR, 0n, 3n * X32);
}

async function block3(client: Client, pool: number) {
  // 02:15 a user swap triggers execution: the TWAMM's net core swap, the VOE,
  // then the user's own swap. Afterwards order A is cut to 6 token0/s.
  await block(client, 3, 2 * HOUR + 15 * MINUTE);
  await swap(client, pool, 3, 0, 0, TWAMM, 40_000n, -30_000n);
  await voe(client, pool, 3, 0, 1, 10n * X32, 3n * X32);
  await swap(client, pool, 3, 0, 2, ROUTER, -50n, 70n);
  await orderUpdate(client, pool, 3, 1, 0, 1, 30 * MINUTE, 3 * HOUR, -4n * X32, 0n);
}

async function block4(client: Client, pool: number) {
  // 03:30 execution after both orders ended; this time the net swap sells token1.
  await block(client, 4, 3 * HOUR + 30 * MINUTE);
  await swap(client, pool, 4, 0, 0, TWAMM, -1_500n, 2_000n);
  await voe(client, pool, 4, 0, 1, 0n, 0n);
}

async function hourly(client: Client) {
  const { rows } = await client.query<{
    hour: Date;
    token: string;
    volume: string;
    fees: string;
  }>(
    `SELECT hour, token::text, volume::text, fees::text
     FROM hourly_volume_by_token
     ORDER BY hour, token`,
  );
  return rows.map((r) => [r.hour.toISOString(), r.token, r.volume, r.fees]);
}

async function totals(client: Client) {
  const { rows } = await client.query<{ token: string; volume: string }>(
    `SELECT token::text, SUM(volume)::text AS volume
     FROM hourly_volume_by_token
     GROUP BY token
     ORDER BY token`,
  );
  return Object.fromEntries(rows.map((r) => [r.token, r.volume]));
}

async function ledgerCount(client: Client) {
  const {
    rows: [{ n }],
  } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM twamm_hourly_volume_by_token`,
  );
  return n;
}

async function reorgFrom(client: Client, blockNumber: number) {
  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number >= $2`,
    [CHAIN_ID, blockNumber],
  );
}

// Expected values, by hand:
//
// Window 00:30 -> 02:15 (block 3). Token0 at 10/s: 18,000 + 36,000 + 9,000 =
// 63,000. Token1 at 3/s from 01:00: 10,800 + 2,700 = 13,500. The TWAMM's core
// swap put 40,000 token0 in, already counted by the swaps trigger, so 23,000
// more token0 is spread 18:36:9 -> 6,571 / 13,142 / 3,285 + 2 remainder on the
// last hour. Token1 had no core-swap input, so it is added as sold.
//
// Window 02:15 -> 03:30 (block 4). Token0 at 6/s until 03:00 = 16,200. Token1
// at 3/s until 02:30 = 2,700, of which the 2,000 core-swap input is already
// counted, so 700 more. All of it was sold in hour 02, while the core swap
// itself lands in hour 03 with the block; the hour-02 share stays positive.
const AFTER_BLOCK_3 = [
  [hour(0), TOKEN0, "6571", "0"],
  [hour(1), TOKEN0, "13142", "0"],
  [hour(1), TOKEN1, "10800", "0"],
  [hour(2), TOKEN0, "43287", "400"],
  [hour(2), TOKEN1, "2770", "1"],
];

const AFTER_BLOCK_4 = [
  [hour(0), TOKEN0, "6571", "0"],
  [hour(1), TOKEN0, "13142", "0"],
  [hour(1), TOKEN1, "10800", "0"],
  [hour(2), TOKEN0, "59487", "400"],
  [hour(2), TOKEN1, "3470", "1"],
  [hour(3), TOKEN1, "2000", "20"],
];

async function seedAll(client: Client) {
  const pool = await seedPool(client);
  await block1(client, pool);
  await block2(client, pool);
  await block3(client, pool);
  await block4(client, pool);
  return pool;
}

test("VOEs add what the orders sold per hour, net of the TWAMM's own core swaps", async () => {
  const client = await createClient();
  const pool = await seedPool(client);

  await block1(client, pool);
  await block2(client, pool);
  expect(await hourly(client)).toEqual([]);

  await block3(client, pool);
  expect(await hourly(client)).toEqual(AFTER_BLOCK_3);
  // Everything sold by the orders plus the user's 70 token1, counted once.
  expect(await totals(client)).toEqual({ [TOKEN0]: "63000", [TOKEN1]: "13570" });

  await block4(client, pool);
  expect(await hourly(client)).toEqual(AFTER_BLOCK_4);
  expect(await totals(client)).toEqual({
    [TOKEN0]: String(63_000 + 16_200),
    [TOKEN1]: String(13_500 + 70 + 2_700),
  });

  await client.close();
});

test("a reorg removes exactly what each VOE added, and replay restores it", async () => {
  const client = await createClient();
  const pool = await seedAll(client);
  expect(await hourly(client)).toEqual(AFTER_BLOCK_4);

  await reorgFrom(client, 4);
  expect(await hourly(client)).toEqual(AFTER_BLOCK_3);

  await block4(client, pool);
  expect(await hourly(client)).toEqual(AFTER_BLOCK_4);

  await reorgFrom(client, 3);
  expect(await hourly(client)).toEqual([]);
  expect(await ledgerCount(client)).toBe(0);

  await block3(client, pool);
  await block4(client, pool);
  expect(await hourly(client)).toEqual(AFTER_BLOCK_4);

  await client.close();
});

test("applying a VOE twice does not double count", async () => {
  const client = await createClient();
  await seedAll(client);
  const rows = await ledgerCount(client);

  await client.query(
    `SELECT insert_twamm_hourly_volume(chain_id, event_id) FROM twamm_virtual_order_executions`,
  );
  expect(await ledgerCount(client)).toBe(rows);
  expect(await hourly(client)).toEqual(AFTER_BLOCK_4);

  await client.close();
});

test("pools without TWAMM orders are unchanged", async () => {
  const client = await createClient();
  const pool = await seedPool(client);
  await block(client, 1, 0);
  await swap(client, pool, 1, 0, 0, ROUTER, 1_000n, -900n);
  await swap(client, pool, 1, 0, 1, TWAMM, 500n, -400n);
  expect(await hourly(client)).toEqual([
    [hour(0), TOKEN0, "1500", "15"],
  ]);
  expect(await ledgerCount(client)).toBe(0);
  await client.close();
});

test("backfill applies history indexed before the migration, idempotently", async () => {
  const client = new PGlite("memory://temp");
  await runMigrationsThrough(client, 136);
  await seedAll(client);
  // Before the migration only core swaps are counted.
  expect(await totals(client)).toEqual({ [TOKEN0]: "40000", [TOKEN1]: "2070" });

  const sql = await fs.readFile(
    path.resolve(process.cwd(), "migrations/00137_twamm_hourly_volume/index.sql"),
    "utf8",
  );
  await client.exec(sql);
  expect(await ledgerCount(client)).toBe(0);

  const backfill = async (after: string, limit: number) => {
    const {
      rows: [row],
    } = await client.query<{ examined: number; last_event_id: string }>(
      `SELECT examined, last_event_id::text FROM backfill_twamm_hourly_volume($1, $2, $3)`,
      [CHAIN_ID, after, limit],
    );
    return row!;
  };

  let cursor = MIN_EVENT_ID;
  let batches = 0;
  for (;;) {
    const { examined, last_event_id } = await backfill(cursor, 1);
    if (examined === 0) break;
    cursor = last_event_id;
    batches++;
  }
  expect(batches).toBe(4);
  expect(await hourly(client)).toEqual(AFTER_BLOCK_4);

  // A rerun from the start only revisits VOEs that contributed nothing.
  expect((await backfill(MIN_EVENT_ID, 100)).examined).toBe(2);
  expect(await hourly(client)).toEqual(AFTER_BLOCK_4);

  await client.close();
});
