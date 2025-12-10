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
  "00030_position_current_liquidity",
  "00037_order_current_sale_rate",
  "00043_order_current_sale_rate_proceeds",
  "00044_order_current_sale_rate_is_selling_token1",
  "00046_add_locker_to_nonfungible_token_views",
  "00048_order_amount_sold_tracking",
  "00060_pool_config_v2",
  "00067_nft_token_salt_function",
  "00068_nft_locker_salt_transform",
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
  isSellingToken1,
}: {
  poolKeyId: number;
  locker: string;
  salt: string;
  startTime: Date;
  endTime: Date;
  isSellingToken1: boolean;
}) {
  const { rows } = await client.query<{
    sale_rate0: string;
    sale_rate1: string;
    total_proceeds_withdrawn0: string;
    total_proceeds_withdrawn1: string;
    is_selling_token1: boolean;
    amount0_sold_last: string;
    amount1_sold_last: string;
    amount_sold_last_block_time: string;
  }>(
    `SELECT sale_rate0,
            sale_rate1,
            total_proceeds_withdrawn0,
            total_proceeds_withdrawn1,
            is_selling_token1,
            amount0_sold_last,
            amount1_sold_last,
            amount_sold_last_block_time::text AS amount_sold_last_block_time
     FROM order_current_sale_rate
     WHERE pool_key_id = $1
       AND locker = $2
       AND salt = $3
       AND start_time = $4
       AND end_time = $5
       AND is_selling_token1 = $6`,
    [poolKeyId, locker, salt, startTime, endTime, isSellingToken1]
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
    isSellingToken1: false,
  });
  expect(token0State.sale_rate0).toBe("100");
  expect(token0State.sale_rate1).toBe("0");
  expect(token0State.total_proceeds_withdrawn0).toBe("0");
  expect(token0State.total_proceeds_withdrawn1).toBe("0");
  expect(token0State.is_selling_token1).toBe(false);
  expect(token0State.amount0_sold_last).toBe("0");
  expect(token0State.amount1_sold_last).toBe("0");
  expect(new Date(token0State.amount_sold_last_block_time).toISOString()).toBe(
    token0Order.start.toISOString()
  );

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
    isSellingToken1: false,
  });
  expect(token0State.is_selling_token1).toBe(false);

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
    isSellingToken1: false,
  });
  expect(token0State.total_proceeds_withdrawn0).toBe("0");
  expect(token0State.total_proceeds_withdrawn1).toBe("5");
  expect(token0State.is_selling_token1).toBe(false);

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
    isSellingToken1: false,
  });
  expect(token0State.total_proceeds_withdrawn0).toBe("0");
  expect(token0State.total_proceeds_withdrawn1).toBe("0");
  expect(token0State.is_selling_token1).toBe(false);

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
    isSellingToken1: true,
  });
  expect(token1State.sale_rate0).toBe("0");
  expect(token1State.sale_rate1).toBe("250");
  expect(token1State.is_selling_token1).toBe(true);

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
    isSellingToken1: true,
  });
  expect(token1State.total_proceeds_withdrawn0).toBe("7");
  expect(token1State.total_proceeds_withdrawn1).toBe("0");
  expect(token1State.is_selling_token1).toBe(true);

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
    isSellingToken1: true,
  });
  expect(token1State.total_proceeds_withdrawn0).toBe("7");
  expect(token1State.is_selling_token1).toBe(true);

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
    isSellingToken1: true,
  });
  expect(orphanState.sale_rate0).toBe("0");
  expect(orphanState.sale_rate1).toBe("0");
  expect(orphanState.total_proceeds_withdrawn0).toBe("3");
  expect(orphanState.total_proceeds_withdrawn1).toBe("0");
  expect(orphanState.is_selling_token1).toBe(true);

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
    isSellingToken1: true,
  });
  expect(orphanState.sale_rate1).toBe("12");
  expect(orphanState.total_proceeds_withdrawn0).toBe("3");
  expect(orphanState.is_selling_token1).toBe(true);

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
    isSellingToken1: true,
  });
  expect(orphanState.total_proceeds_withdrawn0).toBe("0");
  expect(orphanState.total_proceeds_withdrawn1).toBe("0");
  expect(orphanState.sale_rate1).toBe("12");
  expect(orphanState.is_selling_token1).toBe(true);
});

test("order_current_sale_rate tracks amount sold and recomputes on reorgs", async () => {
  const chainId = 2260;
  const blockOne = 150;
  const blockTwo = 151;
  const startTime = new Date("2024-02-02T16:00:00Z");
  const secondTime = new Date(startTime.getTime() + 30_000);
  await seedBlock({ chainId, blockNumber: blockOne, blockTime: startTime });
  await seedBlock({ chainId, blockNumber: blockTwo, blockTime: secondTime });

  const poolKeyId = await insertPoolKey(chainId);

  const baseLocker = "9900";
  const baseSalt = "9910";
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
  const onePerSecond = (1n << 32n).toString();

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
      blockOne,
      0,
      0,
      "9100",
      "9200",
      poolKeyId,
      baseLocker,
      baseSalt,
      onePerSecond,
      "0",
      startTime,
      endTime,
      false,
    ]
  );

  let state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: baseLocker,
    salt: baseSalt,
    startTime,
    endTime,
    isSellingToken1: false,
  });
  expect(state.amount0_sold_last).toBe("0");
  expect(state.amount1_sold_last).toBe("0");
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    startTime.toISOString()
  );

  const {
    rows: [{ event_id: closeEventId }],
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
      blockTwo,
      0,
      1,
      "9101",
      "9201",
      poolKeyId,
      baseLocker,
      baseSalt,
      (-BigInt(onePerSecond)).toString(),
      "0",
      startTime,
      endTime,
      false,
    ]
  );

  state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: baseLocker,
    salt: baseSalt,
    startTime,
    endTime,
    isSellingToken1: false,
  });

  const elapsedSeconds = Math.floor(
    (secondTime.getTime() - startTime.getTime()) / 1000
  ).toString();
  expect(state.amount0_sold_last).toBe(elapsedSeconds);
  expect(state.amount1_sold_last).toBe("0");
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    secondTime.toISOString()
  );

  await client.query(
    `DELETE FROM twamm_order_updates WHERE chain_id = $1 AND event_id = $2`,
    [chainId, closeEventId]
  );

  state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker: baseLocker,
    salt: baseSalt,
    startTime,
    endTime,
    isSellingToken1: false,
  });
  expect(state.amount0_sold_last).toBe("0");
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    startTime.toISOString()
  );
});

test("order_current_sale_rate clamps last block time to the order start when updates arrive early", async () => {
  const chainId = 2270;
  const blockBeforeStart = 152;
  const blockDuring = 153;
  const blockBeforeTime = new Date("2024-02-03T10:00:00Z");
  const startTime = new Date("2024-02-03T10:30:00Z");
  const blockDuringTime = new Date("2024-02-03T10:45:00Z");
  const endTime = new Date("2024-02-03T11:30:00Z");
  await seedBlock({
    chainId,
    blockNumber: blockBeforeStart,
    blockTime: blockBeforeTime,
  });
  await seedBlock({
    chainId,
    blockNumber: blockDuring,
    blockTime: blockDuringTime,
  });

  const poolKeyId = await insertPoolKey(chainId);
  const locker = "10100";
  const salt = "10110";
  const onePerSecond = (1n << 32n).toString();

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
      blockBeforeStart,
      0,
      0,
      "9300",
      "9301",
      poolKeyId,
      locker,
      salt,
      onePerSecond,
      "0",
      startTime,
      endTime,
      false,
    ]
  );

  let state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker,
    salt,
    startTime,
    endTime,
    isSellingToken1: false,
  });
  expect(state.amount0_sold_last).toBe("0");
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    startTime.toISOString()
  );

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
      blockDuring,
      0,
      1,
      "9302",
      "9303",
      poolKeyId,
      locker,
      salt,
      "0",
      "0",
      startTime,
      endTime,
      false,
    ]
  );

  state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker,
    salt,
    startTime,
    endTime,
    isSellingToken1: false,
  });
  const elapsedSinceStart = Math.floor(
    (blockDuringTime.getTime() - startTime.getTime()) / 1000
  ).toString();
  expect(state.amount0_sold_last).toBe(elapsedSinceStart);
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    blockDuringTime.toISOString()
  );
});

test("order_current_sale_rate clamps last block time to the order end when updates arrive late", async () => {
  const chainId = 2280;
  const blockStart = 154;
  const blockAfterEnd = 155;
  const startTime = new Date("2024-02-04T08:00:00Z");
  const endTime = new Date("2024-02-04T09:00:00Z");
  const blockAfterEndTime = new Date(endTime.getTime() + 15 * 60 * 1000);
  await seedBlock({
    chainId,
    blockNumber: blockStart,
    blockTime: startTime,
  });
  await seedBlock({
    chainId,
    blockNumber: blockAfterEnd,
    blockTime: blockAfterEndTime,
  });

  const poolKeyId = await insertPoolKey(chainId);
  const locker = "10200";
  const salt = "10210";
  const onePerSecond = (1n << 32n).toString();

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
      blockStart,
      0,
      0,
      "9400",
      "9401",
      poolKeyId,
      locker,
      salt,
      onePerSecond,
      "0",
      startTime,
      endTime,
      false,
    ]
  );

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
      blockAfterEnd,
      0,
      1,
      "9402",
      "9403",
      poolKeyId,
      locker,
      salt,
      (-BigInt(onePerSecond)).toString(),
      "0",
      startTime,
      endTime,
      false,
    ]
  );

  const state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker,
    salt,
    startTime,
    endTime,
    isSellingToken1: false,
  });
  const totalWindowSeconds = Math.floor(
    (endTime.getTime() - startTime.getTime()) / 1000
  ).toString();
  expect(state.amount0_sold_last).toBe(totalWindowSeconds);
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    endTime.toISOString()
  );
});

test("order_current_sale_rate skips accumulation when an order is entirely in the past", async () => {
  const chainId = 2290;
  const blockAfterEndOne = 156;
  const blockAfterEndTwo = 157;
  const startTime = new Date("2024-02-05T12:00:00Z");
  const endTime = new Date("2024-02-05T13:00:00Z");
  const firstLateBlock = new Date(endTime.getTime() + 10 * 60 * 1000);
  const secondLateBlock = new Date(endTime.getTime() + 20 * 60 * 1000);
  await seedBlock({
    chainId,
    blockNumber: blockAfterEndOne,
    blockTime: firstLateBlock,
  });
  await seedBlock({
    chainId,
    blockNumber: blockAfterEndTwo,
    blockTime: secondLateBlock,
  });

  const poolKeyId = await insertPoolKey(chainId);
  const locker = "10300";
  const salt = "10310";
  const onePerSecond = (1n << 32n).toString();

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
      blockAfterEndOne,
      0,
      0,
      "9500",
      "9501",
      poolKeyId,
      locker,
      salt,
      onePerSecond,
      "0",
      startTime,
      endTime,
      false,
    ]
  );

  let state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker,
    salt,
    startTime,
    endTime,
    isSellingToken1: false,
  });
  expect(state.amount0_sold_last).toBe("0");
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    endTime.toISOString()
  );

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
      blockAfterEndTwo,
      0,
      1,
      "9502",
      "9503",
      poolKeyId,
      locker,
      salt,
      "0",
      "0",
      startTime,
      endTime,
      false,
    ]
  );

  state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker,
    salt,
    startTime,
    endTime,
    isSellingToken1: false,
  });
  expect(state.amount0_sold_last).toBe("0");
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    endTime.toISOString()
  );
});

test("order_current_sale_rate accumulates token0 amounts across sequential updates", async () => {
  const chainId = 2320;
  const blockStart = 158;
  const blockMid = 159;
  const blockClose = 160;
  const startTime = new Date("2024-02-06T00:00:00Z");
  const midTime = new Date(startTime.getTime() + 2 * 60 * 1000);
  const closeTime = new Date(startTime.getTime() + 5 * 60 * 1000);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
  await seedBlock({ chainId, blockNumber: blockStart, blockTime: startTime });
  await seedBlock({ chainId, blockNumber: blockMid, blockTime: midTime });
  await seedBlock({ chainId, blockNumber: blockClose, blockTime: closeTime });

  const poolKeyId = await insertPoolKey(chainId);
  const locker = "10400";
  const salt = "10410";
  const onePerSecond = (1n << 32n).toString();

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
      blockStart,
      0,
      0,
      "9600",
      "9601",
      poolKeyId,
      locker,
      salt,
      onePerSecond,
      "0",
      startTime,
      endTime,
      false,
    ]
  );

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
      blockMid,
      0,
      1,
      "9602",
      "9603",
      poolKeyId,
      locker,
      salt,
      "0",
      "0",
      startTime,
      endTime,
      false,
    ]
  );

  let state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker,
    salt,
    startTime,
    endTime,
    isSellingToken1: false,
  });
  const secondsToMid = Math.floor(
    (midTime.getTime() - startTime.getTime()) / 1000
  ).toString();
  expect(state.amount0_sold_last).toBe(secondsToMid);
  expect(state.sale_rate0).toBe(onePerSecond);
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    midTime.toISOString()
  );

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
      blockClose,
      0,
      2,
      "9604",
      "9605",
      poolKeyId,
      locker,
      salt,
      (-BigInt(onePerSecond)).toString(),
      "0",
      startTime,
      endTime,
      false,
    ]
  );

  state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker,
    salt,
    startTime,
    endTime,
    isSellingToken1: false,
  });
  const secondsToClose = Math.floor(
    (closeTime.getTime() - startTime.getTime()) / 1000
  ).toString();
  expect(state.amount0_sold_last).toBe(secondsToClose);
  expect(state.sale_rate0).toBe("0");
  expect(state.amount1_sold_last).toBe("0");
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    closeTime.toISOString()
  );
});

test("order_current_sale_rate accumulates token1 amounts and recompute matches incremental path", async () => {
  const chainId = 2330;
  const blockStart = 161;
  const blockMid = 162;
  const blockClose = 163;
  const startTime = new Date("2024-02-06T12:00:00Z");
  const midTime = new Date(startTime.getTime() + 90 * 1000);
  const closeTime = new Date(startTime.getTime() + 180 * 1000);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
  await seedBlock({ chainId, blockNumber: blockStart, blockTime: startTime });
  await seedBlock({ chainId, blockNumber: blockMid, blockTime: midTime });
  await seedBlock({ chainId, blockNumber: blockClose, blockTime: closeTime });

  const poolKeyId = await insertPoolKey(chainId);
  const locker = "10500";
  const salt = "10510";
  const twoPerSecond = (2n << 32n).toString();

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
      blockStart,
      0,
      0,
      "9700",
      "9701",
      poolKeyId,
      locker,
      salt,
      "0",
      twoPerSecond,
      startTime,
      endTime,
      true,
    ]
  );

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
      blockMid,
      0,
      1,
      "9702",
      "9703",
      poolKeyId,
      locker,
      salt,
      "0",
      "0",
      startTime,
      endTime,
      true,
    ]
  );

  let state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker,
    salt,
    startTime,
    endTime,
    isSellingToken1: true,
  });
  const secondsToMid = Math.floor(
    (midTime.getTime() - startTime.getTime()) / 1000
  );
  expect(state.amount1_sold_last).toBe((secondsToMid * 2).toString());
  expect(state.amount0_sold_last).toBe("0");
  expect(state.sale_rate1).toBe(twoPerSecond);

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
      blockClose,
      0,
      2,
      "9704",
      "9705",
      poolKeyId,
      locker,
      salt,
      "0",
      (-BigInt(twoPerSecond)).toString(),
      startTime,
      endTime,
      true,
    ]
  );

  state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker,
    salt,
    startTime,
    endTime,
    isSellingToken1: true,
  });
  const secondsToClose = Math.floor(
    (closeTime.getTime() - startTime.getTime()) / 1000
  );
  expect(state.amount1_sold_last).toBe((secondsToClose * 2).toString());
  expect(state.sale_rate1).toBe("0");
  expect(new Date(state.amount_sold_last_block_time).toISOString()).toBe(
    closeTime.toISOString()
  );

  await client.query(
    `SELECT order_current_sale_rate_recompute_amounts($1,$2,$3,$4,$5,$6)`,
    [poolKeyId, locker, salt, startTime, endTime, true]
  );

  state = await getOrderCurrentSaleRate({
    poolKeyId,
    locker,
    salt,
    startTime,
    endTime,
    isSellingToken1: true,
  });
  expect(state.amount1_sold_last).toBe((secondsToClose * 2).toString());
  expect(state.sale_rate1).toBe("0");
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
