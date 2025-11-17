import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00004_pool_states",
  "00006_twamm_tables",
  "00007_twamm_pool_states",
  "00008_twamm_sale_rate_deltas",
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

function nullableBigInt(value: string | number | bigint | null) {
  return value === null ? null : valueToBigInt(value);
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

async function insertPoolKey(chainId: number) {
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
    [chainId, "1000", "2000", "4000", "5000", "10", "1000", 60, "6000"]
  );

  return Number(poolKeyId);
}

test("twamm event tables generate event ids, forbid updates, and cascade on block deletion", async () => {
  const chainId = 2100;
  const blockNumber = 90;
  const blockTime = new Date("2024-02-01T00:00:00Z");

  await seedBlock({ chainId, blockNumber, blockTime });
  const poolKeyId = await insertPoolKey(chainId);

  const txIndex = 1;
  const eventIndex = 3;
  const token0SaleRate = "123";
  const token1SaleRate = "456";

  const {
    rows: [{ event_id: eventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO twamm_virtual_order_executions (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        token0_sale_rate,
        token1_sale_rate
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      txIndex,
      eventIndex,
      "7000",
      "7100",
      poolKeyId,
      token0SaleRate,
      token1SaleRate,
    ]
  );

  expect(eventId).toBe(
    computeEventId({ blockNumber, transactionIndex: txIndex, eventIndex })
  );

  await expect(
    client.query(
      `UPDATE twamm_virtual_order_executions
       SET token0_sale_rate = token0_sale_rate + 1
       WHERE chain_id = $1 AND event_id = $2`,
      [chainId, eventId]
    )
  ).rejects.toThrow(/Updates are not allowed/);

  const {
    rows: [{ event_id: orderUpdateEventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO twamm_order_updates (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        salt,
        sale_rate_delta0,
        sale_rate_delta1,
        start_time,
        end_time
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      txIndex,
      eventIndex + 1,
      "7001",
      "7101",
      poolKeyId,
      "7200",
      "7300",
      "10",
      "-5",
      new Date(blockTime.getTime() - 60000),
      new Date(blockTime.getTime() + 60000),
    ]
  );

  await expect(
    client.query(
      `UPDATE twamm_order_updates
       SET sale_rate_delta0 = sale_rate_delta0 + 1
       WHERE chain_id = $1 AND event_id = $2`,
      [chainId, orderUpdateEventId]
    )
  ).rejects.toThrow(/Updates are not allowed/);

  const withdrawalStart = new Date(blockTime.getTime() - 120000);
  const withdrawalEnd = new Date(blockTime.getTime() - 60000);

  const {
    rows: [{ event_id: withdrawalEventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO twamm_proceeds_withdrawals (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        salt,
        start_time,
        end_time,
        amount0,
        amount1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      txIndex,
      eventIndex + 2,
      "7002",
      "7102",
      poolKeyId,
      "7400",
      "7500",
      withdrawalStart,
      withdrawalEnd,
      "11",
      "22",
    ]
  );

  await expect(
    client.query(
      `UPDATE twamm_proceeds_withdrawals
       SET amount0 = amount0 + 1
       WHERE chain_id = $1 AND event_id = $2`,
      [chainId, withdrawalEventId]
    )
  ).rejects.toThrow(/Updates are not allowed/);

  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, blockNumber]
  );

  const { rows: voeRows } = await client.query(
    `SELECT 1 FROM twamm_virtual_order_executions
     WHERE chain_id = $1 AND event_id = $2`,
    [chainId, eventId]
  );
  const { rows: ouRows } = await client.query(
    `SELECT 1 FROM twamm_order_updates
     WHERE chain_id = $1 AND event_id = $2`,
    [chainId, orderUpdateEventId]
  );
  const { rows: withdrawalRows } = await client.query(
    `SELECT 1 FROM twamm_proceeds_withdrawals
     WHERE chain_id = $1 AND event_id = $2`,
    [chainId, withdrawalEventId]
  );

  expect(voeRows.length).toBe(0);
  expect(ouRows.length).toBe(0);
  expect(withdrawalRows.length).toBe(0);
});

test("twamm order updates maintain sparse sale rate deltas", async () => {
  const chainId = 2200;
  const blockNumber = 120;
  const blockTime = new Date("2024-02-02T00:00:00Z");

  await seedBlock({ chainId, blockNumber, blockTime });
  const poolKeyId = await insertPoolKey(chainId);

  const startTime = new Date("2024-02-02T00:10:00Z");
  const endTime = new Date("2024-02-02T00:30:00Z");
  const delta0 = "40";
  const delta1 = "-15";

  const {
    rows: [{ event_id: eventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO twamm_order_updates (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        salt,
        sale_rate_delta0,
        sale_rate_delta1,
        start_time,
        end_time
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "8000",
      "8100",
      poolKeyId,
      "8200",
      "8300",
      delta0,
      delta1,
      startTime,
      endTime,
    ]
  );

  expect(typeof eventId).toBe("bigint");

  const { rows: deltaRows } = await client.query<{
    time: string;
    net_sale_rate_delta0: string;
    net_sale_rate_delta1: string;
  }>(
    `SELECT "time", net_sale_rate_delta0, net_sale_rate_delta1
     FROM twamm_sale_rate_deltas
     WHERE pool_key_id = $1
     ORDER BY "time" ASC`,
    [poolKeyId]
  );

  const formattedDeltas = deltaRows.map((row) => ({
    time: new Date(row.time).toISOString(),
    net_sale_rate_delta0: row.net_sale_rate_delta0,
    net_sale_rate_delta1: row.net_sale_rate_delta1,
  }));

  expect(formattedDeltas).toEqual([
    {
      time: startTime.toISOString(),
      net_sale_rate_delta0: delta0,
      net_sale_rate_delta1: delta1,
    },
    {
      time: endTime.toISOString(),
      net_sale_rate_delta0: (-BigInt(delta0)).toString(),
      net_sale_rate_delta1: (-BigInt(delta1)).toString(),
    },
  ]);

  await client.query(
    `DELETE FROM twamm_order_updates WHERE chain_id = $1 AND event_id = $2`,
    [chainId, eventId]
  );

  const { rows: afterDeleteRows } = await client.query(
    `SELECT 1 FROM twamm_sale_rate_deltas WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  expect(afterDeleteRows.length).toBe(0);
});

type TwammPoolStateRow = {
  token0_sale_rate: string;
  token1_sale_rate: string;
  last_virtual_execution_time: string;
  last_virtual_order_execution_event_id: string | number | bigint;
  last_order_update_event_id: string | number | bigint | null;
  last_event_id: string | number | bigint;
};

async function getTwammPoolState(poolKeyId: number) {
  const { rows } = await client.query<TwammPoolStateRow>(
    `SELECT
        token0_sale_rate,
        token1_sale_rate,
        last_virtual_execution_time,
        last_virtual_order_execution_event_id,
        last_order_update_event_id,
        last_event_id
     FROM twamm_pool_states
     WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  return rows[0];
}

test("twamm pool states stay in sync with VOE and order update events", async () => {
  const chainId = 2300;
  const baseBlockNumber = 200;
  const voeBlockNumber = 201;
  const ouBlockNumber = 202;

  const baseTime = new Date("2024-02-03T00:00:00Z");
  const voeTime = new Date("2024-02-03T01:00:00Z");
  const orderStartTime = new Date("2024-02-03T01:00:00Z");
  const orderEndTime = new Date("2024-02-03T03:00:00Z");

  await seedBlock({
    chainId,
    blockNumber: baseBlockNumber,
    blockTime: baseTime,
  });
  await seedBlock({ chainId, blockNumber: voeBlockNumber, blockTime: voeTime });
  await seedBlock({
    chainId,
    blockNumber: ouBlockNumber,
    blockTime: orderEndTime,
  });

  const poolKeyId = await insertPoolKey(chainId);

  const {
    rows: [{ pool_state_event_id: poolStateEventId }],
  } = await client.query<{ pool_state_event_id: bigint }>(
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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING event_id AS pool_state_event_id`,
    [chainId, baseBlockNumber, 0, 0, "9000", "9100", poolKeyId, 10, "1000"]
  );

  const basePoolStateEventId = poolStateEventId;

  const baseToken0 = "200";
  const baseToken1 = "400";

  const {
    rows: [{ event_id: voeEventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO twamm_virtual_order_executions (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        token0_sale_rate,
        token1_sale_rate
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING event_id`,
    [
      chainId,
      voeBlockNumber,
      0,
      1,
      "9001",
      "9101",
      poolKeyId,
      baseToken0,
      baseToken1,
    ]
  );

  const initialState = await getTwammPoolState(poolKeyId);
  expect(initialState).toBeDefined();
  expect(initialState.token0_sale_rate).toBe(baseToken0);
  expect(initialState.token1_sale_rate).toBe(baseToken1);
  expect(initialState.last_order_update_event_id).toBeNull();
  expect(new Date(initialState.last_virtual_execution_time).toISOString()).toBe(
    voeTime.toISOString()
  );
  expect(
    valueToBigInt(initialState.last_virtual_order_execution_event_id)
  ).toBe(voeEventId);
  expect(valueToBigInt(initialState.last_event_id)).toBe(
    voeEventId > basePoolStateEventId ? voeEventId : basePoolStateEventId
  );

  const delta0 = "50";
  const delta1 = "-20";

  const {
    rows: [{ event_id: orderUpdateEventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO twamm_order_updates (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        salt,
        sale_rate_delta0,
        sale_rate_delta1,
        start_time,
        end_time
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING event_id`,
    [
      chainId,
      ouBlockNumber,
      0,
      2,
      "9002",
      "9102",
      poolKeyId,
      "9200",
      "9300",
      delta0,
      delta1,
      orderStartTime,
      orderEndTime,
    ]
  );

  const updatedState = await getTwammPoolState(poolKeyId);
  expect(updatedState.token0_sale_rate).toBe(
    (BigInt(baseToken0) + BigInt(delta0)).toString()
  );
  expect(updatedState.token1_sale_rate).toBe(
    (BigInt(baseToken1) + BigInt(delta1)).toString()
  );
  expect(nullableBigInt(updatedState.last_order_update_event_id)).toBe(
    orderUpdateEventId
  );
  expect(valueToBigInt(updatedState.last_event_id)).toBe(
    orderUpdateEventId > basePoolStateEventId
      ? orderUpdateEventId
      : basePoolStateEventId
  );

  await client.query(
    `DELETE FROM twamm_order_updates WHERE chain_id = $1 AND event_id = $2`,
    [chainId, orderUpdateEventId]
  );

  const stateAfterDelete = await getTwammPoolState(poolKeyId);
  expect(stateAfterDelete.token0_sale_rate).toBe(baseToken0);
  expect(stateAfterDelete.token1_sale_rate).toBe(baseToken1);
  expect(stateAfterDelete.last_order_update_event_id).toBeNull();
  expect(valueToBigInt(stateAfterDelete.last_event_id)).toBe(
    voeEventId > basePoolStateEventId ? voeEventId : basePoolStateEventId
  );

  await client.query(
    `DELETE FROM twamm_virtual_order_executions WHERE chain_id = $1 AND event_id = $2`,
    [chainId, voeEventId]
  );

  const { rows: finalRows } = await client.query(
    `SELECT 1 FROM twamm_pool_states WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  expect(finalRows.length).toBe(0);
});
