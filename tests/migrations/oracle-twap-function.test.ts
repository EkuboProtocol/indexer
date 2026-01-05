import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00009_oracle_tables",
  "00010_oracle_pool_states",
  "00018_tokens",
  "00019_hourly_tables",
  "00026_hourly_tables_block_time",
  "00042_oracle_twap_function",
  "00060_pool_config_v2",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  await client.close();
});

async function insertBlock({
  chainId,
  blockNumber,
  timestamp,
}: {
  chainId: number;
  blockNumber: number;
  timestamp: number;
}) {
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 0)`,
    [
      chainId,
      blockNumber,
      `${chainId}${blockNumber}`,
      new Date(timestamp * 1000),
    ]
  );
}

async function insertPoolKey({
  chainId,
  token0,
  token1,
  emitter,
}: {
  chainId: number;
  token0: string;
  token1: string;
  emitter: string;
}) {
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
    [
      chainId,
      "1000",
      `${chainId}${token0}${token1}`,
      token0,
      token1,
      "1",
      "1000000",
      60,
      emitter,
    ]
  );

  return Number(pool_key_id);
}

async function insertPoolInitialization({
  chainId,
  poolKeyId,
  blockNumber,
  tick,
  transactionIndex = 0,
  eventIndex = 0,
}: {
  chainId: number;
  poolKeyId: number;
  blockNumber: number;
  tick: number;
  transactionIndex?: number;
  eventIndex?: number;
}) {
  await client.query(
    `INSERT INTO pool_initializations (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        tick,
        sqrt_ratio
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      chainId,
      blockNumber,
      transactionIndex,
      eventIndex,
      `${blockNumber}${poolKeyId}${transactionIndex}`,
      "0",
      poolKeyId,
      tick,
      "1",
    ]
  );
}

async function insertSwap({
  chainId,
  poolKeyId,
  blockNumber,
  transactionIndex,
  eventIndex,
  tickAfter,
}: {
  chainId: number;
  poolKeyId: number;
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  tickAfter: number;
}) {
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
      transactionIndex,
      eventIndex,
      `${blockNumber}${poolKeyId}${transactionIndex}`,
      "0",
      poolKeyId,
      "0",
      "0",
      "0",
      "1",
      tickAfter,
      "1000",
    ]
  );
}

async function insertOracleSnapshot({
  chainId,
  blockNumber,
  transactionIndex,
  eventIndex,
  token0,
  token1,
  emitter,
  timestamp,
  tickCumulative,
}: {
  chainId: number;
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  token0: string;
  token1: string;
  emitter: string;
  timestamp: bigint;
  tickCumulative: bigint;
}) {
  await client.query(
    `INSERT INTO oracle_snapshots (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        token0,
        token1,
        snapshot_block_timestamp,
        snapshot_tick_cumulative,
        snapshot_seconds_per_liquidity_cumulative
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      chainId,
      blockNumber,
      transactionIndex,
      eventIndex,
      `${chainId}${blockNumber}${transactionIndex}`,
      emitter,
      token0,
      token1,
      timestamp.toString(),
      tickCumulative.toString(),
      null,
    ]
  );
}

test("computes the latest TWAP price between two tokens", async () => {
  const chainId = 4210;
  const baseToken = "769";
  const quoteToken = "770";
  const oracleToken = "771";
  const durationSeconds = 10n;
  const oracleExtension = "1001";

  await insertBlock({ chainId, blockNumber: 1, timestamp: 1000 });
  await insertBlock({ chainId, blockNumber: 2, timestamp: 1005 });
  await insertBlock({ chainId, blockNumber: 3, timestamp: 1010 });
  await insertBlock({ chainId, blockNumber: 4, timestamp: 1015 });

  const basePoolKeyId = await insertPoolKey({
    chainId,
    token0: oracleToken,
    token1: baseToken,
    emitter: oracleExtension,
  });
  const quotePoolKeyId = await insertPoolKey({
    chainId,
    token0: quoteToken,
    token1: oracleToken,
    emitter: oracleExtension,
  });

  await insertPoolInitialization({
    chainId,
    poolKeyId: basePoolKeyId,
    blockNumber: 1,
    tick: 18,
  });
  await insertPoolInitialization({
    chainId,
    poolKeyId: quotePoolKeyId,
    blockNumber: 1,
    tick: -35,
    transactionIndex: 0,
    eventIndex: 1,
  });

  await insertSwap({
    chainId,
    poolKeyId: basePoolKeyId,
    blockNumber: 2,
    transactionIndex: 0,
    eventIndex: 0,
    tickAfter: 20,
  });
  await insertSwap({
    chainId,
    poolKeyId: basePoolKeyId,
    blockNumber: 4,
    transactionIndex: 0,
    eventIndex: 1,
    tickAfter: 30,
  });

  await insertSwap({
    chainId,
    poolKeyId: quotePoolKeyId,
    blockNumber: 2,
    transactionIndex: 1,
    eventIndex: 0,
    tickAfter: -31,
  });
  await insertSwap({
    chainId,
    poolKeyId: quotePoolKeyId,
    blockNumber: 4,
    transactionIndex: 1,
    eventIndex: 1,
    tickAfter: -29,
  });

  // base snapshots stored as (oracle, base)
  await insertOracleSnapshot({
    chainId,
    blockNumber: 1,
    transactionIndex: 0,
    eventIndex: 0,
    token0: oracleToken,
    token1: baseToken,
    emitter: oracleExtension,
    timestamp: 1000n,
    tickCumulative: 20000n,
  });
  await insertOracleSnapshot({
    chainId,
    blockNumber: 3,
    transactionIndex: 0,
    eventIndex: 0,
    token0: oracleToken,
    token1: baseToken,
    emitter: oracleExtension,
    timestamp: 1010n,
    tickCumulative: 20220n,
  });

  // quote snapshots stored as (quote, oracle)
  await insertOracleSnapshot({
    chainId,
    blockNumber: 1,
    transactionIndex: 1,
    eventIndex: 0,
    token0: quoteToken,
    token1: oracleToken,
    emitter: oracleExtension,
    timestamp: 1000n,
    tickCumulative: -40000n,
  });
  await insertOracleSnapshot({
    chainId,
    blockNumber: 3,
    transactionIndex: 1,
    eventIndex: 0,
    token0: quoteToken,
    token1: oracleToken,
    emitter: oracleExtension,
    timestamp: 1010n,
    tickCumulative: -40330n,
  });

  const {
    rows: [{ tick }],
  } = await client.query<{ tick: number | string | null }>(
    `SELECT get_pair_twap_tick($1,$2,$3,$4,$5,$6) AS tick`,
    [
      chainId,
      oracleExtension,
      oracleToken,
      baseToken,
      quoteToken,
      Number(durationSeconds),
    ]
  );

  expect(tick).not.toBeNull();
  const numericTick = Number(tick);
  expect(numericTick).toBe(5);
  const price = Math.pow(1.000001, numericTick);
  const expectedPrice = Math.pow(1.000001, 5);
  expect(price).toBeCloseTo(expectedPrice, 12);
});

test("returns null when either pair lacks sufficient history", async () => {
  const chainId = 4211;
  const baseToken = "800";
  const quoteToken = "801";
  const oracleToken = "802";
  const oracleExtension = "2001";

  await insertBlock({ chainId, blockNumber: 10, timestamp: 5000 });
  const basePoolKeyId = await insertPoolKey({
    chainId,
    token0: oracleToken,
    token1: baseToken,
    emitter: oracleExtension,
  });

  await insertPoolInitialization({
    chainId,
    poolKeyId: basePoolKeyId,
    blockNumber: 10,
    tick: 12,
  });
  await insertSwap({
    chainId,
    poolKeyId: basePoolKeyId,
    blockNumber: 10,
    transactionIndex: 0,
    eventIndex: 0,
    tickAfter: 12,
  });

  await insertOracleSnapshot({
    chainId,
    blockNumber: 10,
    transactionIndex: 0,
    eventIndex: 0,
    token0: oracleToken,
    token1: baseToken,
    emitter: oracleExtension,
    timestamp: 5000n,
    tickCumulative: 1000n,
  });

  const {
    rows: [{ tick }],
  } = await client.query<{ tick: null }>(
    `SELECT get_pair_twap_tick($1,$2,$3,$4,$5,$6) AS tick`,
    [chainId, oracleExtension, oracleToken, baseToken, quoteToken, 60]
  );

  expect(tick).toBeNull();
});

test("throws when the TWAP duration is non-positive", async () => {
  const chainId = 4212;
  const baseToken = "900";
  const quoteToken = "901";
  const oracleToken = "902";
  const oracleExtension = "3001";

  await expect(
    client.query(`SELECT get_pair_twap_tick($1,$2,$3,$4,$5,$6)`, [
      chainId,
      oracleExtension,
      oracleToken,
      baseToken,
      quoteToken,
      0,
    ])
  ).rejects.toThrow(/twap duration must be positive/i);
});
