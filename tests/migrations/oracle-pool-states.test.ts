import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00009_oracle_tables",
  "00010_oracle_pool_states",
  "00060_pool_config_v2",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  await client.close();
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

function valueToBigInt(value: string | number | bigint) {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  return BigInt(value);
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
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
     VALUES ($1, $2, $3, $4)`,
    [chainId, blockNumber, blockHash, blockTime]
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
    [chainId, "1000", "2000", token0, token1, "10", "1000", 60, emitter]
  );

  return Number(poolKeyId);
}

async function getOraclePoolState(poolKeyId: number) {
  const { rows } = await client.query<{
    last_snapshot_block_timestamp: string | number | bigint;
  }>(
    `SELECT last_snapshot_block_timestamp
     FROM oracle_pool_states
     WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  return rows[0];
}

test("oracle snapshots generate event ids, forbid updates, and cascade cleanup keeps state consistent", async () => {
  const chainId = 3100;
  const blockNumber = 500;
  const blockTime = new Date("2024-03-01T00:00:00Z");
  const token0 = "7100";
  const token1 = "7200";
  const emitter = "7300";
  const snapshotTimestamp = 1710000000n;

  await seedBlock({ chainId, blockNumber, blockTime });
  const poolKeyId = await insertPoolKey({ chainId, token0, token1, emitter });

  const {
    rows: [{ event_id: snapshotEventId }],
  } = await client.query<{ event_id: bigint }>(
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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "8000",
      emitter,
      token0,
      token1,
      snapshotTimestamp.toString(),
      "9000",
      null,
    ]
  );

  expect(snapshotEventId).toBe(
    computeEventId({ blockNumber, transactionIndex: 0, eventIndex: 0 })
  );

  const poolState = await getOraclePoolState(poolKeyId);
  expect(poolState).toBeDefined();
  expect(valueToBigInt(poolState.last_snapshot_block_timestamp)).toBe(
    snapshotTimestamp
  );

  await expect(
    client.query(
      `UPDATE oracle_snapshots
       SET snapshot_tick_cumulative = snapshot_tick_cumulative + 1
       WHERE chain_id = $1 AND event_id = $2`,
      [chainId, snapshotEventId]
    )
  ).rejects.toThrow(/Updates are not allowed/);

  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, blockNumber]
  );

  const { rows: remainingSnapshots } = await client.query(
    `SELECT 1 FROM oracle_snapshots WHERE chain_id = $1`,
    [chainId]
  );
  expect(remainingSnapshots.length).toBe(0);

  const { rows: remainingStates } = await client.query(
    `SELECT 1 FROM oracle_pool_states WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  expect(remainingStates.length).toBe(0);
});

test("deleting blocks rewinds oracle pool state to the previous snapshot", async () => {
  const chainId = 3200;
  const baseBlock = 600;
  const reorgBlock = 601;
  const token0 = "111";
  const token1 = "222";
  const emitter = "333";
  const firstTimestamp = 1700000000n;
  const secondTimestamp = 1700001000n;

  await seedBlock({
    chainId,
    blockNumber: baseBlock,
    blockTime: new Date("2024-04-01T00:00:00Z"),
  });
  await seedBlock({
    chainId,
    blockNumber: reorgBlock,
    blockTime: new Date("2024-04-02T00:00:00Z"),
  });

  const poolKeyId = await insertPoolKey({ chainId, token0, token1, emitter });

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
      baseBlock,
      0,
      0,
      "4100",
      emitter,
      token0,
      token1,
      firstTimestamp.toString(),
      "5000",
      "6000",
    ]
  );

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
      reorgBlock,
      0,
      0,
      "4101",
      emitter,
      token0,
      token1,
      secondTimestamp.toString(),
      "5001",
      "6001",
    ]
  );

  let state = await getOraclePoolState(poolKeyId);
  expect(state).toBeDefined();
  expect(valueToBigInt(state.last_snapshot_block_timestamp)).toBe(
    secondTimestamp
  );

  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, reorgBlock]
  );

  state = await getOraclePoolState(poolKeyId);
  expect(state).toBeDefined();
  expect(valueToBigInt(state.last_snapshot_block_timestamp)).toBe(
    firstTimestamp
  );

  const { rows: remainingSnapshots } = await client.query(
    `SELECT 1
     FROM oracle_snapshots
     WHERE chain_id = $1 AND block_number = $2`,
    [chainId, reorgBlock]
  );
  expect(remainingSnapshots.length).toBe(0);
});

test("oracle pool states track latest snapshot and roll back when snapshots are removed", async () => {
  const chainId = 3201;
  const token0 = "8100";
  const token1 = "8200";
  const emitter = "8300";

  const blockNumbers = [100, 101, 102];
  const baseTime = new Date("2024-03-02T00:00:00Z");

  for (let i = 0; i < blockNumbers.length; i += 1) {
    await seedBlock({
      chainId,
      blockNumber: blockNumbers[i],
      blockTime: new Date(baseTime.getTime() + i * 60_000),
    });
  }

  const poolKeyId = await insertPoolKey({ chainId, token0, token1, emitter });

  const timestamps = [
    100n, // block 100
    150n, // block 101
    120n, // block 102 (older timestamp but later event id)
  ];

  async function insertSnapshot({
    blockNumber,
    eventIndex,
    timestamp,
    txSuffix,
  }: {
    blockNumber: number;
    eventIndex: number;
    timestamp: bigint;
    txSuffix: number;
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
        0,
        eventIndex,
        `900${txSuffix}`,
        emitter,
        token0,
        token1,
        timestamp.toString(),
        `100${txSuffix}`,
        `200${txSuffix}`,
      ]
    );
  }

  await insertSnapshot({
    blockNumber: 100,
    eventIndex: 0,
    timestamp: timestamps[0],
    txSuffix: 0,
  });

  let state = await getOraclePoolState(poolKeyId);
  expect(state).toBeDefined();
  expect(valueToBigInt(state.last_snapshot_block_timestamp)).toBe(
    timestamps[0]
  );

  await insertSnapshot({
    blockNumber: 101,
    eventIndex: 1,
    timestamp: timestamps[1],
    txSuffix: 1,
  });

  state = await getOraclePoolState(poolKeyId);
  expect(valueToBigInt(state.last_snapshot_block_timestamp)).toBe(
    timestamps[1]
  );

  await insertSnapshot({
    blockNumber: 102,
    eventIndex: 2,
    timestamp: timestamps[2],
    txSuffix: 2,
  });

  state = await getOraclePoolState(poolKeyId);
  expect(valueToBigInt(state.last_snapshot_block_timestamp)).toBe(
    timestamps[1]
  );

  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, 101]
  );

  state = await getOraclePoolState(poolKeyId);
  expect(valueToBigInt(state.last_snapshot_block_timestamp)).toBe(
    timestamps[2]
  );

  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, 102]
  );

  state = await getOraclePoolState(poolKeyId);
  expect(valueToBigInt(state.last_snapshot_block_timestamp)).toBe(
    timestamps[0]
  );

  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, 100]
  );

  const { rows: stateRows } = await client.query(
    `SELECT 1 FROM oracle_pool_states WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  expect(stateRows.length).toBe(0);
});
