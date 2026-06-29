import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  createClient,
  ensureIndexerCursor,
  runMigrations,
  runMigrationsThrough,
} from "../helpers/db.js";

let client: PGlite;

beforeAll(async () => {
  client = await createClient();
});

afterAll(async () => {
  await client.close();
});

async function seedBlock({
  db = client,
  chainId,
  blockNumber,
  blockTime,
}: {
  db?: PGlite;
  chainId: number;
  blockNumber: number;
  blockTime: Date;
}) {
  await ensureIndexerCursor(db, chainId);
  await db.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 0)`,
    [chainId, blockNumber, `${chainId}${blockNumber}`, blockTime],
  );
}

async function seedVe33Pool(chainId: number, db = client) {
  const {
    rows: [{ pool_key_id: poolKeyId }],
  } = await db.query<{ pool_key_id: bigint }>(
    `INSERT INTO pool_keys (
        chain_id,
        core_address,
        pool_id,
        token0,
        token1,
        fee,
        fee_denominator,
        tick_spacing,
        pool_extension,
        pool_config,
        pool_config_type
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING pool_key_id`,
    [
      chainId,
      "1000",
      "2000",
      "3000",
      "4000",
      "0",
      "1000000",
      64,
      "5000",
      "0",
      "concentrated",
    ],
  );

  await db.query(
    `INSERT INTO pool_states (
        pool_key_id,
        sqrt_ratio,
        tick,
        liquidity,
        last_event_id,
        last_position_update_event_id
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [poolKeyId, "100", 5, "200", 10, null],
  );

  return poolKeyId;
}

async function insertVoteWeightApplied({
  db = client,
  chainId,
  blockNumber,
  eventIndex,
  poolKeyId,
  weight,
  swapFee,
}: {
  db?: PGlite;
  chainId: number;
  blockNumber: number;
  eventIndex: number;
  poolKeyId: bigint;
  weight: string;
  swapFee: string;
}) {
  await db.query(
    `INSERT INTO ve33_vote_weight_applied (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        pool_id,
        owner,
        stake_id,
        stake_salt,
        stake_end_time,
        weight,
        swap_fee
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      chainId,
      blockNumber,
      0,
      eventIndex,
      `900${eventIndex}`,
      "5000",
      poolKeyId,
      "2000",
      "7000",
      "8000",
      "80",
      new Date("2027-01-01T00:00:00.000Z"),
      weight,
      swapFee,
    ],
  );
}

test("ve33 pool state recomputes from pool events and surfaces in all_pool_states_view", async () => {
  const chainId = 11155111;
  const firstBlockTime = new Date("2026-06-29T00:00:00.000Z");
  const secondBlockTime = new Date("2026-06-29T00:10:00.000Z");
  await seedBlock({ chainId, blockNumber: 1, blockTime: firstBlockTime });
  await seedBlock({ chainId, blockNumber: 2, blockTime: secondBlockTime });
  const poolKeyId = await seedVe33Pool(chainId);

  await insertVoteWeightApplied({
    chainId,
    blockNumber: 1,
    eventIndex: 0,
    poolKeyId,
    weight: "100",
    swapFee: "25",
  });

  await insertVoteWeightApplied({
    chainId,
    blockNumber: 2,
    eventIndex: 0,
    poolKeyId,
    weight: "150",
    swapFee: "30",
  });

  await client.query(
    `INSERT INTO ve33_pool_fees_accounted (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        pool_id,
        amount0,
        amount1
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [chainId, 2, 0, 1, "9002", "5000", poolKeyId, "2000", "5", "7"],
  );

  await client.query(
    `INSERT INTO ve33_pool_emissions_accrued (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        pool_key_id,
        pool_id,
        amount
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [chainId, 2, 0, 2, "9003", "5000", poolKeyId, "2000", "11"],
  );

  const { rows: stateRows } = await client.query<{
    pool_total_vote_weight: string;
    swap_fee: string;
    last_pool_fees_accounted_amount0: string;
    last_pool_fees_accounted_amount1: string;
    total_pool_emissions_accrued: string;
  }>(
    `SELECT pool_total_vote_weight,
            swap_fee,
            last_pool_fees_accounted_amount0,
            last_pool_fees_accounted_amount1,
            total_pool_emissions_accrued
     FROM ve33_pool_states
     WHERE pool_key_id = $1`,
    [poolKeyId],
  );

  expect(stateRows).toEqual([
    {
      pool_total_vote_weight: "150",
      swap_fee: "30",
      last_pool_fees_accounted_amount0: "5",
      last_pool_fees_accounted_amount1: "7",
      total_pool_emissions_accrued: "11",
    },
  ]);

  const { rows: viewRows } = await client.query<{
    is_ve33_pool: boolean;
    ve33_swap_fee: string;
    ve33_pool_total_vote_weight: string;
    ve33_last_pool_fees_accounted_time: number;
    ve33_last_pool_emissions_accrued_time: number;
    ve33_total_pool_emissions_accrued: string;
  }>(
    `SELECT is_ve33_pool,
            ve33_swap_fee,
            ve33_pool_total_vote_weight,
            ve33_last_pool_fees_accounted_time,
            ve33_last_pool_emissions_accrued_time,
            ve33_total_pool_emissions_accrued
     FROM all_pool_states_view
     WHERE pool_key_id = $1`,
    [poolKeyId],
  );

  expect(viewRows).toEqual([
    {
      is_ve33_pool: true,
      ve33_swap_fee: "30",
      ve33_pool_total_vote_weight: "150",
      ve33_last_pool_fees_accounted_time: Math.floor(
        secondBlockTime.getTime() / 1000,
      ),
      ve33_last_pool_emissions_accrued_time: Math.floor(
        secondBlockTime.getTime() / 1000,
      ),
      ve33_total_pool_emissions_accrued: "11",
    },
  ]);

  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, 2],
  );

  const { rows: afterDeleteRows } = await client.query<{
    pool_total_vote_weight: string;
    swap_fee: string;
    total_pool_fees_accounted0: string;
    total_pool_emissions_accrued: string;
  }>(
    `SELECT pool_total_vote_weight,
            swap_fee,
            total_pool_fees_accounted0,
            total_pool_emissions_accrued
     FROM ve33_pool_states
     WHERE pool_key_id = $1`,
    [poolKeyId],
  );

  expect(afterDeleteRows).toEqual([
    {
      pool_total_vote_weight: "100",
      swap_fee: "25",
      total_pool_fees_accounted0: "0",
      total_pool_emissions_accrued: "0",
    },
  ]);

  await client.query(`DELETE FROM blocks WHERE chain_id = $1`, [chainId]);

  const { rows: emptyRows } = await client.query(
    `SELECT 1 FROM ve33_pool_states WHERE pool_key_id = $1`,
    [poolKeyId],
  );

  expect(emptyRows).toHaveLength(0);
});

test("ve33 pool state backfills events that existed before the state migration", async () => {
  const db = new PGlite("memory://ve33-backfill");
  try {
    await runMigrationsThrough(db, 104);

    const chainId = 11155112;
    await seedBlock({
      db,
      chainId,
      blockNumber: 1,
      blockTime: new Date("2026-06-29T01:00:00.000Z"),
    });
    const poolKeyId = await seedVe33Pool(chainId, db);

    await insertVoteWeightApplied({
      db,
      chainId,
      blockNumber: 1,
      eventIndex: 0,
      poolKeyId,
      weight: "77",
      swapFee: "13",
    });

    await runMigrations(db, { files: ["00105_ve33_pool_states"] });

    const { rows } = await db.query<{
      pool_total_vote_weight: string;
      swap_fee: string;
    }>(
      `SELECT pool_total_vote_weight, swap_fee
       FROM ve33_pool_states
       WHERE pool_key_id = $1`,
      [poolKeyId],
    );

    expect(rows).toEqual([{ pool_total_vote_weight: "77", swap_fee: "13" }]);
  } finally {
    await db.close();
  }
});
