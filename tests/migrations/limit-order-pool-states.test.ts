import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00004_pool_states",
  "00013_limit_orders",
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
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 0)`,
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

async function insertPoolInitialization({
  chainId,
  blockNumber,
  poolKeyId,
  eventIndex = 0,
}: {
  chainId: number;
  blockNumber: number;
  poolKeyId: number;
  eventIndex?: number;
}) {
  const {
    rows: [{ event_id: eventId }],
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
    [chainId, blockNumber, 0, eventIndex, "6000", "7000", poolKeyId, 10, "1200"]
  );

  return eventId;
}

async function insertLimitOrderPlaced({
  chainId,
  blockNumber,
  poolKeyId,
  eventIndex,
}: {
  chainId: number;
  blockNumber: number;
  poolKeyId: number;
  eventIndex: number;
}) {
  const {
    rows: [{ event_id: eventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO limit_order_placed (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        salt,
        token0,
        token1,
        tick,
        liquidity,
        amount
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      eventIndex,
      "8000",
      "8000",
      poolKeyId,
      "8100",
      "8200",
      "8300",
      "8400",
      15,
      "900",
      "100",
    ]
  );

  return eventId;
}

async function insertLimitOrderClosed({
  chainId,
  blockNumber,
  poolKeyId,
  eventIndex,
}: {
  chainId: number;
  blockNumber: number;
  poolKeyId: number;
  eventIndex: number;
}) {
  const {
    rows: [{ event_id: eventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO limit_order_closed (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        locker,
        salt,
        token0,
        token1,
        tick,
        amount0,
        amount1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      0,
      eventIndex,
      "8001",
      "8001",
      poolKeyId,
      "8100",
      "8200",
      "8300",
      "8400",
      15,
      "50",
      "75",
    ]
  );

  return eventId;
}

async function getLimitOrderPoolState(poolKeyId: number) {
  const { rows } = await client.query<{
    last_event_id: string | number | bigint;
  }>(
    `SELECT last_event_id
     FROM limit_order_pool_states
     WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  return rows[0] ?? null;
}

test("limit order pool state tracks placements, closures, and cleans up when events are removed", async () => {
  const chainId = 4100;
  const blockNumbers = {
    init: 200,
    placed: 201,
    closed: 202,
  };

  await seedBlock({
    chainId,
    blockNumber: blockNumbers.init,
    blockTime: new Date("2024-04-01T00:00:00Z"),
  });
  await seedBlock({
    chainId,
    blockNumber: blockNumbers.placed,
    blockTime: new Date("2024-04-01T00:05:00Z"),
  });
  await seedBlock({
    chainId,
    blockNumber: blockNumbers.closed,
    blockTime: new Date("2024-04-01T00:10:00Z"),
  });

  const poolKeyId = await insertPoolKey(chainId);

  await insertPoolInitialization({
    chainId,
    blockNumber: blockNumbers.init,
    poolKeyId,
  });

  // No placements yet => no pool state row
  expect(await getLimitOrderPoolState(poolKeyId)).toBeNull();

  const placedEventId = await insertLimitOrderPlaced({
    chainId,
    blockNumber: blockNumbers.placed,
    poolKeyId,
    eventIndex: 0,
  });

  const stateAfterPlacement = await getLimitOrderPoolState(poolKeyId);
  expect(stateAfterPlacement).not.toBeNull();
  expect(valueToBigInt(stateAfterPlacement!.last_event_id)).toBe(0n);
  expect(placedEventId).toBe(
    computeEventId({
      blockNumber: blockNumbers.placed,
      transactionIndex: 0,
      eventIndex: 0,
    })
  );

  const closedEventId = await insertLimitOrderClosed({
    chainId,
    blockNumber: blockNumbers.closed,
    poolKeyId,
    eventIndex: 0,
  });

  const stateAfterClosure = await getLimitOrderPoolState(poolKeyId);
  expect(stateAfterClosure).not.toBeNull();
  expect(valueToBigInt(stateAfterClosure!.last_event_id)).toBe(
    closedEventId > placedEventId ? closedEventId : placedEventId
  );

  await client.query(
    `DELETE FROM limit_order_closed WHERE chain_id = $1 AND event_id = $2`,
    [chainId, closedEventId]
  );

  const stateAfterClosedDeletion = await getLimitOrderPoolState(poolKeyId);
  expect(stateAfterClosedDeletion).not.toBeNull();
  expect(valueToBigInt(stateAfterClosedDeletion!.last_event_id)).toBe(0n);

  await client.query(
    `DELETE FROM limit_order_placed WHERE chain_id = $1 AND event_id = $2`,
    [chainId, placedEventId]
  );

  expect(await getLimitOrderPoolState(poolKeyId)).toBeNull();
});

test("limit order pool state drops when underlying pool state is removed", async () => {
  const chainId = 4200;
  const blockNumbers = {
    init: 300,
    placed: 301,
  };

  await seedBlock({
    chainId,
    blockNumber: blockNumbers.init,
    blockTime: new Date("2024-04-02T00:00:00Z"),
  });
  await seedBlock({
    chainId,
    blockNumber: blockNumbers.placed,
    blockTime: new Date("2024-04-02T00:05:00Z"),
  });

  const poolKeyId = await insertPoolKey(chainId);
  await insertPoolInitialization({
    chainId,
    blockNumber: blockNumbers.init,
    poolKeyId,
  });

  await insertLimitOrderPlaced({
    chainId,
    blockNumber: blockNumbers.placed,
    poolKeyId,
    eventIndex: 0,
  });

  expect(await getLimitOrderPoolState(poolKeyId)).not.toBeNull();

  await client.query(`DELETE FROM pool_states WHERE pool_key_id = $1`, [
    poolKeyId,
  ]);

  // limit_order_placed row should still exist (different block)
  const { rows: placements } = await client.query(
    `SELECT 1 FROM limit_order_placed WHERE chain_id = $1`,
    [chainId]
  );
  expect(placements.length).toBe(1);

  expect(await getLimitOrderPoolState(poolKeyId)).toBeNull();
});
