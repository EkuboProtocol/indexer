import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00004_pool_states",
  "00005_per_pool_per_tick_liquidity",
  "00006_twamm_tables",
  "00007_twamm_pool_states",
  "00008_twamm_sale_rate_deltas",
  "00009_oracle_tables",
  "00010_oracle_pool_states",
  "00013_limit_orders",
  "00014_spline_tables",
  "00017_mev_capture_tables",
  "00019_hourly_tables",
  "00026_hourly_tables_block_time",
  "00060_pool_config_v2",
  "00091_boosted_fees",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  if (client) {
    await client.close();
  }
});

function computeEventId({
  blockNumber,
  transactionIndex,
  eventIndex,
}: {
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
}) {
  const blockLimit = 2n ** 32n;
  const indexLimit = 2n ** 16n;
  return (
    -9223372036854775807n +
    BigInt(blockNumber) * blockLimit +
    BigInt(transactionIndex) * indexLimit +
    BigInt(eventIndex)
  );
}

async function seedBlock({
  chainId,
  blockNumber,
  blockTime,
}: {
  chainId: number;
  blockNumber: number;
  blockTime: Date;
}) {
  const blockHash = `${chainId}${blockNumber}`;
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 0)`,
    [chainId, blockNumber, blockHash, blockTime]
  );
}

async function insertPoolKey(chainId: number, poolId: string) {
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
    [chainId, "1000", poolId, "4000", "5000", "10", "1000", 60, "6000"]
  );

  return Number(poolKeyId);
}

test("boosted fee deltas track stored and actual rates", async () => {
  const chainId = 1;
  const blockNumber = 1;
  const blockTime = new Date("2024-01-01T00:00:00.000Z");
  await seedBlock({ chainId, blockNumber, blockTime });

  const poolKeyId = await insertPoolKey(chainId, "2000");
  await client.query(
    `INSERT INTO pool_states (pool_key_id, sqrt_ratio, tick, liquidity, last_event_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [poolKeyId, "1", 0, "0", "1"]
  );
  const startTime = new Date("2023-12-31T23:00:00.000Z");
  const endTime = new Date("2024-01-01T02:00:00.000Z");

  await client.query(
    `INSERT INTO boosted_fees_events (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        start_time,
        end_time,
        rate0,
        rate1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "999",
      "111",
      poolKeyId,
      startTime,
      endTime,
      "100",
      "200",
    ]
  );

  const { rows } = await client.query<{
    time: string;
    net_donate_rate_delta0: string;
    net_donate_rate_delta1: string;
  }>(
    `SELECT "time",
            net_donate_rate_delta0,
            net_donate_rate_delta1
     FROM boosted_fees_donate_rate_deltas
     WHERE pool_key_id = $1
     ORDER BY "time"`,
    [poolKeyId]
  );

  const expectedTimes = [startTime.toISOString(), endTime.toISOString()];

  expect(rows).toHaveLength(2);
  rows.forEach((row, index) => {
    expect(new Date(row.time).toISOString()).toBe(expectedTimes[index]);
  });
  expect(rows[0]).toMatchObject({
    net_donate_rate_delta0: "100",
    net_donate_rate_delta1: "200",
  });
  expect(rows[1]).toMatchObject({
    net_donate_rate_delta0: "-100",
    net_donate_rate_delta1: "-200",
  });

  await client.query(
    `INSERT INTO boosted_fees_donated (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        donate_rate0,
        donate_rate1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [chainId, blockNumber, 0, 1, "123", "222", poolKeyId, "0", "0"]
  );
  const { rows: viewRows } = await client.query<{
    boosted_fees_donate_rate0: string | null;
    boosted_fees_donate_rate1: string | null;
    boosted_fees_donations: string | null;
  }>(
    `SELECT boosted_fees_donate_rate0,
            boosted_fees_donate_rate1,
            boosted_fees_donations
     FROM all_pool_states_view
     WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  expect(viewRows).toHaveLength(1);
  expect(viewRows[0]?.boosted_fees_donate_rate0).toBe("0");
  expect(viewRows[0]?.boosted_fees_donate_rate1).toBe("0");
  const donations = viewRows[0]?.boosted_fees_donations;
  if (typeof donations === "string") {
    expect(donations).toContain('"s0":"-100"');
    expect(donations).toContain('"s1":"-200"');
  } else {
    expect(Array.isArray(donations)).toBe(true);
    expect(donations?.[0]?.s0).toBe("-100");
    expect(donations?.[0]?.s1).toBe("-200");
  }

  const eventId = computeEventId({
    blockNumber,
    transactionIndex: 0,
    eventIndex: 0,
  });
  await client.query(
    `DELETE FROM boosted_fees_events WHERE chain_id = $1 AND event_id = $2`,
    [chainId, eventId.toString()]
  );

  const { rows: deletedRows } = await client.query(
    `SELECT 1 FROM boosted_fees_donate_rate_deltas WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  expect(deletedRows).toHaveLength(0);
});

test("actual boosted fee deltas skip boosts entirely in the past", async () => {
  const chainId = 1;
  const blockNumber = 2;
  const blockTime = new Date("2024-01-02T00:00:00.000Z");
  await seedBlock({ chainId, blockNumber, blockTime });

  const poolKeyId = await insertPoolKey(chainId, "3000");
  const startTime = new Date("2024-01-01T20:00:00.000Z");
  const endTime = new Date("2024-01-01T22:00:00.000Z");

  await client.query(
    `INSERT INTO boosted_fees_events (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        start_time,
        end_time,
        rate0,
        rate1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "999",
      "111",
      poolKeyId,
      startTime,
      endTime,
      "50",
      "75",
    ]
  );

  const { rows } = await client.query<{
    time: string;
    net_donate_rate_delta0: string;
    net_donate_rate_delta1: string;
  }>(
    `SELECT "time",
            net_donate_rate_delta0,
            net_donate_rate_delta1
     FROM boosted_fees_donate_rate_deltas
     WHERE pool_key_id = $1
     ORDER BY "time"`,
    [poolKeyId]
  );

  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    net_donate_rate_delta0: "50",
    net_donate_rate_delta1: "75",
  });
  expect(rows[1]).toMatchObject({
    net_donate_rate_delta0: "-50",
    net_donate_rate_delta1: "-75",
  });
});
