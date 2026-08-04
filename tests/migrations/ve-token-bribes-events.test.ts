import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00002_core_tables",
  "00115_ve_token_bribes_events",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  await client.close();
});

async function seedBlock(chainId: number, blockNumber: number) {
  await ensureIndexerCursor(client, chainId);
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 0)`,
    [
      chainId,
      blockNumber,
      `${chainId}${blockNumber}`,
      new Date("2026-08-03T00:00:00.000Z"),
    ],
  );
}

async function seedPoolKey(chainId: number) {
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
    [chainId, "1000", "2000", "3000", "4000", "0", "1000000", 64, "5000"],
  );

  return poolKeyId.toString();
}

test("bribe creations resolve the pool key and store the bribe key", async () => {
  const chainId = 11155111;
  const blockNumber = 1;
  await seedBlock(chainId, blockNumber);
  const poolKeyId = await seedPoolKey(chainId);

  await client.query(
    `INSERT INTO ve_token_bribes_created (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        bribe_id,
        pool_key_id,
        pool_id,
        reward_token,
        owner,
        voting_fee
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,
        (SELECT pk.pool_key_id FROM pool_keys pk
         WHERE pk.chain_id = $1 AND pk.core_address = $8 AND pk.pool_id = $9),
        $9,$10,$11,$12)`,
    [
      chainId,
      blockNumber,
      0,
      0,
      "9000",
      "6000",
      "1234",
      "1000",
      "2000",
      "3000",
      "5500",
      "17",
    ],
  );

  await client.query(
    `INSERT INTO ve_token_bribes_voting_fee_updated (
        chain_id, block_number, transaction_index, event_index,
        transaction_hash, emitter, bribe_id, voting_fee
     ) VALUES ($1,$2,0,1,$3,$4,$5,$6)`,
    [chainId, blockNumber, "9010", "6000", "1234", "42"],
  );

  const { rows } = await client.query<{
    pool_key_id: string;
    bribe_id: string;
    reward_token: string;
    owner: string;
    voting_fee: string;
  }>(
    `SELECT pool_key_id, bribe_id, reward_token, owner, voting_fee
     FROM ve_token_bribes_created
     WHERE chain_id = $1`,
    [chainId],
  );

  expect(
    rows.map((row) => ({ ...row, pool_key_id: String(row.pool_key_id) })),
  ).toEqual([
    {
      pool_key_id: poolKeyId,
      bribe_id: "1234",
      reward_token: "3000",
      owner: "5500",
      voting_fee: "17",
    },
  ]);

  const { rows: feeRows } = await client.query<{ voting_fee: string }>(
    `SELECT u.voting_fee
     FROM ve_token_bribes_voting_fee_updated u
     JOIN ve_token_bribes_created c
       ON c.chain_id = u.chain_id AND c.emitter = u.emitter AND c.bribe_id = u.bribe_id
     WHERE u.chain_id = $1
     ORDER BY u.event_id DESC`,
    [chainId],
  );
  expect(feeRows).toEqual([{ voting_fee: "42" }]);
});

test("bribe stake and schedule events join on the bribe id", async () => {
  const chainId = 11155112;
  const blockNumber = 2;
  await seedBlock(chainId, blockNumber);

  await client.query(
    `INSERT INTO ve_token_bribes_staked (
        chain_id, block_number, transaction_index, event_index,
        transaction_hash, emitter, bribe_id, owner, ve_id, weight
     ) VALUES ($1,$2,0,0,$3,$4,$5,$6,$7,$8)`,
    [chainId, blockNumber, "9001", "6000", "1234", "7000", "1", "500"],
  );
  await client.query(
    `INSERT INTO ve_token_bribes_rewards_scheduled (
        chain_id, block_number, transaction_index, event_index,
        transaction_hash, emitter, bribe_id, funder, start_time, end_time,
        reward_rate, amount
     ) VALUES ($1,$2,0,1,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      chainId,
      blockNumber,
      "9002",
      "6000",
      "1234",
      "7000",
      new Date("2026-08-03T00:00:00.000Z"),
      new Date("2026-08-10T00:00:00.000Z"),
      "1000000",
      "700",
    ],
  );

  const { rows } = await client.query<{ weight: string; amount: string }>(
    `SELECT s.weight, r.amount
     FROM ve_token_bribes_staked s
     JOIN ve_token_bribes_rewards_scheduled r
       ON r.chain_id = s.chain_id AND r.emitter = s.emitter AND r.bribe_id = s.bribe_id
     WHERE s.chain_id = $1`,
    [chainId],
  );

  expect(rows).toEqual([{ weight: "500", amount: "700" }]);
});

test("deleting a block cascades bribe event rows", async () => {
  const chainId = 11155113;
  const blockNumber = 3;
  await seedBlock(chainId, blockNumber);

  await client.query(
    `INSERT INTO ve_token_bribes_unstaked (
        chain_id, block_number, transaction_index, event_index,
        transaction_hash, emitter, bribe_id, owner, ve_id, weight
     ) VALUES ($1,$2,0,0,$3,$4,$5,$6,$7,$8)`,
    [chainId, blockNumber, "9003", "6000", "1234", "7000", "1", "500"],
  );
  await client.query(
    `INSERT INTO ve_token_bribes_reward_paid (
        chain_id, block_number, transaction_index, event_index,
        transaction_hash, emitter, bribe_id, owner, ve_id, amount
     ) VALUES ($1,$2,0,1,$3,$4,$5,$6,$7,$8)`,
    [chainId, blockNumber, "9004", "6000", "1234", "7000", "1", "42"],
  );
  await client.query(
    `INSERT INTO ve_token_bribes_vote_refreshed (
        chain_id, block_number, transaction_index, event_index,
        transaction_hash, emitter, bribe_id, owner, ve_id, previous_weight, weight
     ) VALUES ($1,$2,0,2,$3,$4,$5,$6,$7,$8,$9)`,
    [chainId, blockNumber, "9005", "6000", "1234", "7000", "1", "500", "400"],
  );
  await client.query(
    `INSERT INTO ve_token_bribes_voting_fees_claimed (
        chain_id, block_number, transaction_index, event_index,
        transaction_hash, emitter, bribe_id, owner, ve_id, recipient, amount0, amount1
     ) VALUES ($1,$2,0,3,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      chainId,
      blockNumber,
      "9006",
      "6000",
      "1234",
      "7000",
      "1",
      "7000",
      "5",
      "6",
    ],
  );

  await client.query(`DELETE FROM blocks WHERE chain_id = $1`, [chainId]);

  for (const table of [
    "ve_token_bribes_unstaked",
    "ve_token_bribes_reward_paid",
    "ve_token_bribes_vote_refreshed",
    "ve_token_bribes_voting_fees_claimed",
  ]) {
    const {
      rows: [{ result }],
    } = await client.query<{ result: number }>(
      `SELECT count(1) AS result FROM ${table} WHERE chain_id = $1`,
      [chainId],
    );
    expect(result).toBe(0);
  }
});
