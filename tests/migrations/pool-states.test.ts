import { beforeAll, afterAll, test, expect } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00003_nonfungible_tokens",
  "00004_pool_states",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  await client.close();
});

async function seedPool(client: PGlite, chainId: number) {
  const blockNumber = chainId * 100;
  const blockHash = (blockNumber + 1).toString();
  const blockTime = new Date("2024-01-01T00:00:00Z");

  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
     VALUES ($1, $2, $3, $4)`,
    [chainId, blockNumber, blockHash, blockTime]
  );

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
    [chainId, "2000", "3000", "4000", "4001", "100", "1000000", 60, "5000"]
  );

  return { chainId, blockNumber, poolKeyId: Number(poolKeyId) };
}

type PoolStateRow = {
  sqrt_ratio: string;
  tick: number;
  liquidity: string;
  last_event_id: string | number | bigint | null;
  last_position_update_event_id: string | number | bigint | null;
};

async function getPoolState(client: PGlite, poolKeyId: number) {
  const { rows } = await client.query<PoolStateRow>(
    `SELECT
        sqrt_ratio,
        tick,
        liquidity,
        last_event_id,
        last_position_update_event_id
     FROM pool_states
     WHERE pool_key_id = $1`,
    [poolKeyId]
  );

  expect(rows.length).toBe(1);
  return rows[0];
}

function valueToBigInt(value: string | number | bigint | null) {
  if (value === null) {
    throw new Error("expected bigint but received null");
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  return BigInt(value);
}

test("position updates adjust pool state and deletion reverts to last swap", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, 10);

  const {
    rows: [{ event_id: initEventId }],
  } = await client.query<{ event_id: bigint }>(
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
     RETURNING event_id`,
    [chainId, blockNumber, 0, 0, "6000", "7000", poolKeyId, 20, "1500"]
  );

  let state = await getPoolState(client, poolKeyId);
  expect(state).toMatchObject({
    sqrt_ratio: "1500",
    tick: 20,
    liquidity: "0",
    last_position_update_event_id: null,
  });
  expect(valueToBigInt(state.last_event_id)).toBe(initEventId);

  const swapValues = {
    delta0: "-100",
    delta1: "200",
    sqrt_ratio_after: "2500",
    tick_after: 25,
    liquidity_after: "1000",
  };

  const {
    rows: [{ event_id: swapEventId }],
  } = await client.query<{ event_id: bigint }>(
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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      1,
      "6001",
      "7001",
      poolKeyId,
      "8001",
      swapValues.delta0,
      swapValues.delta1,
      swapValues.sqrt_ratio_after,
      swapValues.tick_after,
      swapValues.liquidity_after,
    ]
  );

  state = await getPoolState(client, poolKeyId);
  expect(state).toMatchObject({
    sqrt_ratio: swapValues.sqrt_ratio_after,
    tick: swapValues.tick_after,
    liquidity: swapValues.liquidity_after,
    last_position_update_event_id: null,
  });
  expect(valueToBigInt(state.last_event_id)).toBe(swapEventId);

  const positionDelta = "250";
  const {
    rows: [{ event_id: positionEventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO position_updates (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        salt,
        lower_bound,
        upper_bound,
        liquidity_delta,
        delta0,
        delta1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      2,
      "6002",
      "7002",
      poolKeyId,
      "8002",
      "9002",
      20,
      30,
      positionDelta,
      "0",
      "0",
    ]
  );

  state = await getPoolState(client, poolKeyId);
  expect(state).toMatchObject({
    sqrt_ratio: swapValues.sqrt_ratio_after,
    tick: swapValues.tick_after,
    liquidity: "1250",
  });
  expect(state.last_event_id).toBe(positionEventId);
  expect(state.last_position_update_event_id).toBe(positionEventId);

  await client.query(
    `DELETE FROM position_updates WHERE chain_id = $1 AND event_id = $2`,
    [chainId, positionEventId]
  );

  state = await getPoolState(client, poolKeyId);
  expect(state).toMatchObject({
    sqrt_ratio: swapValues.sqrt_ratio_after,
    tick: swapValues.tick_after,
    liquidity: swapValues.liquidity_after,
    last_position_update_event_id: null,
  });
  expect(valueToBigInt(state.last_event_id)).toBe(swapEventId);
});

test("deleting a swap restores the previous pool state snapshot", async () => {
  const { chainId, blockNumber, poolKeyId } = await seedPool(client, 11);

  const {
    rows: [{ event_id: initEventId }],
  } = await client.query<{ event_id: bigint }>(
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
     RETURNING event_id`,
    [chainId, blockNumber, 0, 0, "6100", "7100", poolKeyId, 30, "1800"]
  );

  const swapOne = {
    sqrt_ratio_after: "2400",
    tick_after: 32,
    liquidity_after: "900",
  };

  const {
    rows: [{ event_id: swapOneEventId }],
  } = await client.query<{ event_id: bigint }>(
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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      1,
      "6101",
      "7101",
      poolKeyId,
      "8101",
      "-10",
      "5",
      swapOne.sqrt_ratio_after,
      swapOne.tick_after,
      swapOne.liquidity_after,
    ]
  );

  let state = await getPoolState(client, poolKeyId);
  expect(state).toMatchObject({
    sqrt_ratio: swapOne.sqrt_ratio_after,
    tick: swapOne.tick_after,
    liquidity: swapOne.liquidity_after,
    last_position_update_event_id: null,
  });
  expect(valueToBigInt(state.last_event_id)).toBe(swapOneEventId);

  const swapTwo = {
    sqrt_ratio_after: "3000",
    tick_after: 40,
    liquidity_after: "1200",
  };

  const {
    rows: [{ event_id: swapTwoEventId }],
  } = await client.query<{ event_id: bigint }>(
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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      2,
      "6102",
      "7102",
      poolKeyId,
      "8102",
      "-20",
      "10",
      swapTwo.sqrt_ratio_after,
      swapTwo.tick_after,
      swapTwo.liquidity_after,
    ]
  );

  state = await getPoolState(client, poolKeyId);
  expect(state).toMatchObject({
    sqrt_ratio: swapTwo.sqrt_ratio_after,
    tick: swapTwo.tick_after,
    liquidity: swapTwo.liquidity_after,
    last_position_update_event_id: null,
  });
  expect(valueToBigInt(state.last_event_id)).toBe(swapTwoEventId);

  await client.query(
    `DELETE FROM swaps WHERE chain_id = $1 AND event_id = $2`,
    [chainId, swapTwoEventId]
  );

  state = await getPoolState(client, poolKeyId);
  expect(state).toMatchObject({
    sqrt_ratio: swapOne.sqrt_ratio_after,
    tick: swapOne.tick_after,
    liquidity: swapOne.liquidity_after,
    last_position_update_event_id: null,
  });
  expect(valueToBigInt(state.last_event_id)).toBe(swapOneEventId);
  expect(valueToBigInt(state.last_event_id)).not.toBe(initEventId);
});

test("deleting blocks cascades swap and position data to refresh pool state", async () => {
  const {
    chainId,
    blockNumber: baseBlock,
    poolKeyId,
  } = await seedPool(client, 12);
  const reorgBlock = baseBlock + 1;

  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
     VALUES ($1, $2, $3, $4)`,
    [
      chainId,
      reorgBlock,
      `${reorgBlock}${chainId}`,
      new Date("2024-01-02T00:00:00Z"),
    ]
  );

  const {
    rows: [{ event_id: initEventId }],
  } = await client.query<{ event_id: bigint }>(
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
     RETURNING event_id`,
    [chainId, baseBlock, 0, 0, "7100", "8100", poolKeyId, 18, "1600"]
  );

  const {
    rows: [{ event_id: baseSwapEventId }],
  } = await client.query<{ event_id: bigint }>(
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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING event_id`,
    [
      chainId,
      baseBlock,
      0,
      1,
      "7101",
      "8101",
      poolKeyId,
      "9101",
      "-40",
      "20",
      "2000",
      24,
      "900",
    ]
  );

  const {
    rows: [{ event_id: reorgSwapEventId }],
  } = await client.query<{ event_id: bigint }>(
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
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING event_id`,
    [
      chainId,
      reorgBlock,
      0,
      0,
      "7200",
      "8200",
      poolKeyId,
      "9200",
      "-30",
      "15",
      "2400",
      30,
      "1200",
    ]
  );

  const {
    rows: [{ event_id: positionEventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO position_updates (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        salt,
        lower_bound,
        upper_bound,
        liquidity_delta,
        delta0,
        delta1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING event_id`,
    [
      chainId,
      reorgBlock,
      0,
      1,
      "7201",
      "8201",
      poolKeyId,
      "9201",
      "10201",
      10,
      40,
      "300",
      "0",
      "0",
    ]
  );

  let state = await getPoolState(client, poolKeyId);
  expect(state).toMatchObject({
    sqrt_ratio: "2400",
    tick: 30,
    liquidity: "1500",
  });
  expect(valueToBigInt(state.last_event_id)).toBe(positionEventId);
  expect(valueToBigInt(state.last_position_update_event_id)).toBe(
    positionEventId
  );

  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, reorgBlock]
  );

  state = await getPoolState(client, poolKeyId);
  expect(state).toMatchObject({
    sqrt_ratio: "2000",
    tick: 24,
    liquidity: "900",
  });
  expect(valueToBigInt(state.last_event_id)).toBe(baseSwapEventId);
  expect(state.last_position_update_event_id).toBeNull();

  const { rows: remainingSwaps } = await client.query(
    `SELECT 1 FROM swaps WHERE chain_id = $1 AND block_number = $2`,
    [chainId, reorgBlock]
  );
  expect(remainingSwaps.length).toBe(0);

  const { rows: remainingPositionUpdates } = await client.query(
    `SELECT 1 FROM position_updates WHERE chain_id = $1 AND block_number = $2`,
    [chainId, reorgBlock]
  );
  expect(remainingPositionUpdates.length).toBe(0);

  expect(valueToBigInt(initEventId)).toBeLessThan(
    valueToBigInt(baseSwapEventId)
  );
  expect(valueToBigInt(baseSwapEventId)).toBeLessThan(
    valueToBigInt(reorgSwapEventId)
  );
});
