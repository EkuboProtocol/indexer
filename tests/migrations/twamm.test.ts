import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00003_nonfungible_tokens",
  "00004_pool_states",
  "00006_twamm_tables",
  "00007_twamm_pool_states",
  "00008_twamm_sale_rate_deltas",
  "00029_nft_locker_mappings",
  "00037_order_current_sale_rate",
  "00043_order_current_sale_rate_proceeds",
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

async function getOrderCurrentSaleRate({
  poolKeyId,
  locker,
  salt,
  startTime,
  endTime,
}: {
  poolKeyId: number;
  locker: string;
  salt: string;
  startTime: Date;
  endTime: Date;
}) {
  const { rows } = await client.query<{
    sale_rate0: string;
    sale_rate1: string;
    total_proceeds_withdrawn0: string;
    total_proceeds_withdrawn1: string;
    is_token1: boolean;
  }>(
    `SELECT sale_rate0,
            sale_rate1,
            total_proceeds_withdrawn0,
            total_proceeds_withdrawn1,
            is_token1
     FROM order_current_sale_rate
     WHERE pool_key_id = $1
       AND locker = $2
       AND salt = $3
       AND start_time = $4
       AND end_time = $5`,
    [poolKeyId, locker, salt, startTime, endTime]
  );

  return rows[0];
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

  const orderStartTime = new Date(blockTime.getTime() - 60000);
  const orderEndTime = new Date(blockTime.getTime() + 60000);

  const locker = "7200";
  const salt = "7300";

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
        end_time,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      txIndex,
      eventIndex + 1,
      "7001",
      "7101",
      poolKeyId,
      locker,
      salt,
      "0",
      "-5",
      orderStartTime,
      orderEndTime,
      true,
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

  const withdrawalStart = orderStartTime;
  const withdrawalEnd = orderEndTime;

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
        amount1,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      txIndex,
      eventIndex + 2,
      "7002",
      "7102",
      poolKeyId,
      locker,
      salt,
      withdrawalStart,
      withdrawalEnd,
      "11",
      "0",
      true,
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
  const delta1 = "0";

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
        end_time,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
      delta1 !== "0",
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

test("order_current_sale_rate captures proceeds totals and token side", async () => {
  const chainId = 2250;
  const blockNumber = 140;
  const blockTime = new Date("2024-02-02T12:00:00Z");
  await seedBlock({ chainId, blockNumber, blockTime });
  const poolKeyId = await insertPoolKey(chainId);

  const token0Order = {
    locker: "9100",
    salt: "9200",
    start: new Date("2024-02-02T12:05:00Z"),
    end: new Date("2024-02-02T13:05:00Z"),
  };

  await client.query(
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
        end_time,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "8000",
      "8100",
      poolKeyId,
      token0Order.locker,
      token0Order.salt,
      "100",
      "0",
      token0Order.start,
      token0Order.end,
      false,
    ]
  );

  let token0State = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: token0Order.locker,
    salt: token0Order.salt,
    startTime: token0Order.start,
    endTime: token0Order.end,
  });
  expect(token0State.sale_rate0).toBe("100");
  expect(token0State.sale_rate1).toBe("0");
  expect(token0State.total_proceeds_withdrawn0).toBe("0");
  expect(token0State.total_proceeds_withdrawn1).toBe("0");
  expect(token0State.is_token1).toBe(false);

  await client.query(
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
        end_time,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      chainId,
      blockNumber,
      0,
      1,
      "8001",
      "8101",
      poolKeyId,
      token0Order.locker,
      token0Order.salt,
      "0",
      "0",
      token0Order.start,
      token0Order.end,
      false,
    ]
  );

  token0State = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: token0Order.locker,
    salt: token0Order.salt,
    startTime: token0Order.start,
    endTime: token0Order.end,
  });
  expect(token0State.is_token1).toBe(false);

  const {
    rows: [{ event_id: token0WithdrawalId }],
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
        amount1,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      2,
      "8002",
      "8102",
      poolKeyId,
      token0Order.locker,
      token0Order.salt,
      token0Order.start,
      token0Order.end,
      "0",
      "5",
      false,
    ]
  );

  token0State = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: token0Order.locker,
    salt: token0Order.salt,
    startTime: token0Order.start,
    endTime: token0Order.end,
  });
  expect(token0State.total_proceeds_withdrawn0).toBe("0");
  expect(token0State.total_proceeds_withdrawn1).toBe("5");
  expect(token0State.is_token1).toBe(false);

  await client.query(
    `DELETE FROM twamm_proceeds_withdrawals WHERE chain_id = $1 AND event_id = $2`,
    [chainId, token0WithdrawalId]
  );

  token0State = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: token0Order.locker,
    salt: token0Order.salt,
    startTime: token0Order.start,
    endTime: token0Order.end,
  });
  expect(token0State.total_proceeds_withdrawn0).toBe("0");
  expect(token0State.total_proceeds_withdrawn1).toBe("0");
  expect(token0State.is_token1).toBe(false);

  const token1Order = {
    locker: "9300",
    salt: "9400",
    start: new Date("2024-02-02T13:10:00Z"),
    end: new Date("2024-02-02T14:10:00Z"),
  };

  await client.query(
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
        end_time,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      chainId,
      blockNumber,
      0,
      3,
      "8003",
      "8103",
      poolKeyId,
      token1Order.locker,
      token1Order.salt,
      "0",
      "250",
      token1Order.start,
      token1Order.end,
      true,
    ]
  );

  let token1State = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: token1Order.locker,
    salt: token1Order.salt,
    startTime: token1Order.start,
    endTime: token1Order.end,
  });
  expect(token1State.sale_rate0).toBe("0");
  expect(token1State.sale_rate1).toBe("250");
  expect(token1State.is_token1).toBe(true);

  await client.query(
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
        amount1,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      chainId,
      blockNumber,
      0,
      4,
      "8004",
      "8104",
      poolKeyId,
      token1Order.locker,
      token1Order.salt,
      token1Order.start,
      token1Order.end,
      "7",
      "0",
      true,
    ]
  );

  token1State = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: token1Order.locker,
    salt: token1Order.salt,
    startTime: token1Order.start,
    endTime: token1Order.end,
  });
  expect(token1State.total_proceeds_withdrawn0).toBe("7");
  expect(token1State.total_proceeds_withdrawn1).toBe("0");
  expect(token1State.is_token1).toBe(true);

  await client.query(
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
        amount1,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      chainId,
      blockNumber,
      0,
      5,
      "8005",
      "8105",
      poolKeyId,
      token1Order.locker,
      token1Order.salt,
      token1Order.start,
      token1Order.end,
      "0",
      "0",
      true,
    ]
  );

  token1State = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: token1Order.locker,
    salt: token1Order.salt,
    startTime: token1Order.start,
    endTime: token1Order.end,
  });
  expect(token1State.total_proceeds_withdrawn0).toBe("7");
  expect(token1State.is_token1).toBe(true);

  const orphanOrder = {
    locker: "9500",
    salt: "9600",
    start: new Date("2024-02-02T14:20:00Z"),
    end: new Date("2024-02-02T15:20:00Z"),
  };

  const {
    rows: [{ event_id: orphanWithdrawalId }],
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
        amount1,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      6,
      "8006",
      "8106",
      poolKeyId,
      orphanOrder.locker,
      orphanOrder.salt,
      orphanOrder.start,
      orphanOrder.end,
      "3",
      "0",
      true,
    ]
  );

  let orphanState = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: orphanOrder.locker,
    salt: orphanOrder.salt,
    startTime: orphanOrder.start,
    endTime: orphanOrder.end,
  });
  expect(orphanState.sale_rate0).toBe("0");
  expect(orphanState.sale_rate1).toBe("0");
  expect(orphanState.total_proceeds_withdrawn0).toBe("3");
  expect(orphanState.total_proceeds_withdrawn1).toBe("0");
  expect(orphanState.is_token1).toBe(true);

  await client.query(
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
        end_time,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      chainId,
      blockNumber,
      0,
      7,
      "8007",
      "8107",
      poolKeyId,
      orphanOrder.locker,
      orphanOrder.salt,
      "0",
      "12",
      orphanOrder.start,
      orphanOrder.end,
      true,
    ]
  );

  orphanState = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: orphanOrder.locker,
    salt: orphanOrder.salt,
    startTime: orphanOrder.start,
    endTime: orphanOrder.end,
  });
  expect(orphanState.sale_rate1).toBe("12");
  expect(orphanState.total_proceeds_withdrawn0).toBe("3");
  expect(orphanState.is_token1).toBe(true);

  await client.query(
    `DELETE FROM twamm_proceeds_withdrawals WHERE chain_id = $1 AND event_id = $2`,
    [chainId, orphanWithdrawalId]
  );

  orphanState = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: orphanOrder.locker,
    salt: orphanOrder.salt,
    startTime: orphanOrder.start,
    endTime: orphanOrder.end,
  });
  expect(orphanState.total_proceeds_withdrawn0).toBe("0");
  expect(orphanState.total_proceeds_withdrawn1).toBe("0");
  expect(orphanState.sale_rate1).toBe("12");
  expect(orphanState.is_token1).toBe(true);
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
    rows: [{ event_id: orderUpdateEventId0 }],
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
        end_time,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
      "0",
      orderStartTime,
      orderEndTime,
      false,
    ]
  );

  const {
    rows: [{ event_id: orderUpdateEventId1 }],
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
        end_time,
        is_selling_token1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING event_id`,
    [
      chainId,
      ouBlockNumber,
      0,
      3,
      "9003",
      "9103",
      poolKeyId,
      "9200",
      "9300",
      "0",
      delta1,
      orderStartTime,
      orderEndTime,
      true,
    ]
  );

  const orderUpdateEventId = orderUpdateEventId1;

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
    [chainId, orderUpdateEventId0]
  );
  await client.query(
    `DELETE FROM twamm_order_updates WHERE chain_id = $1 AND event_id = $2`,
    [chainId, orderUpdateEventId1]
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
