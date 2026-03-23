import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00012_governance_tables",
  "00099_calculate_staker_rewards_function",
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
  chainId: string;
  blockNumber: number;
  timestamp: string;
}) {
  await client.query(
    `INSERT INTO indexer_cursor (chain_id, order_key, unique_key, last_updated)
     VALUES ($1, 0, NULL, NOW())
     ON CONFLICT (chain_id) DO NOTHING`,
    [chainId]
  );
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 0)`,
    [chainId, blockNumber, `${chainId}${blockNumber}`, timestamp]
  );
}

async function insertStake({
  chainId,
  blockNumber,
  transactionIndex,
  eventIndex,
  emitter,
  fromAddress,
  amount,
  delegate,
}: {
  chainId: string;
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  emitter: string;
  fromAddress: string;
  amount: string;
  delegate: string;
}) {
  await client.query(
    `INSERT INTO staker_staked (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        from_address,
        amount,
        delegate
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      chainId,
      blockNumber,
      transactionIndex,
      eventIndex,
      `${chainId}${blockNumber}${transactionIndex}${eventIndex}`,
      emitter,
      fromAddress,
      amount,
      delegate,
    ]
  );
}

async function insertWithdrawal({
  chainId,
  blockNumber,
  transactionIndex,
  eventIndex,
  emitter,
  fromAddress,
  amount,
  recipient,
  delegate,
}: {
  chainId: string;
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  emitter: string;
  fromAddress: string;
  amount: string;
  recipient: string;
  delegate: string;
}) {
  await client.query(
    `INSERT INTO staker_withdrawn (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        from_address,
        amount,
        recipient,
        delegate
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      chainId,
      blockNumber,
      transactionIndex,
      eventIndex,
      `${chainId}${blockNumber}${transactionIndex}${eventIndex}`,
      emitter,
      fromAddress,
      amount,
      recipient,
      delegate,
    ]
  );
}

async function insertProposal({
  chainId,
  blockNumber,
  transactionIndex,
  eventIndex,
  emitter,
  proposalId,
  proposer,
}: {
  chainId: string;
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  emitter: string;
  proposalId: string;
  proposer: string;
}) {
  await client.query(
    `INSERT INTO governor_proposed (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        proposal_id,
        proposer,
        config_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      chainId,
      blockNumber,
      transactionIndex,
      eventIndex,
      `${chainId}${blockNumber}${transactionIndex}${eventIndex}`,
      emitter,
      proposalId,
      proposer,
      "0",
    ]
  );
}

async function insertVote({
  chainId,
  blockNumber,
  transactionIndex,
  eventIndex,
  emitter,
  proposalId,
  voter,
  weight,
}: {
  chainId: string;
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  emitter: string;
  proposalId: string;
  voter: string;
  weight: string;
}) {
  await client.query(
    `INSERT INTO governor_voted (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        proposal_id,
        voter,
        weight,
        yea
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      chainId,
      blockNumber,
      transactionIndex,
      eventIndex,
      `${chainId}${blockNumber}${transactionIndex}${eventIndex}`,
      emitter,
      proposalId,
      voter,
      weight,
      true,
    ]
  );
}

test("calculate_staker_rewards matches the old reward split on the current schema", async () => {
  const chainId = "23448594291968334";
  const stakerAddress =
    "1194257563955965460367353409140405763780761879270528111624067674852467116981";
  const governorAddress =
    "2354502934501836923955011505963489193673442986857363336683304411560511969997";
  const stakerA = "10";
  const stakerB = "11";
  const delegateB = "12";

  await insertBlock({
    chainId,
    blockNumber: 1,
    timestamp: "2024-01-01T00:00:00Z",
  });
  await insertBlock({
    chainId,
    blockNumber: 2,
    timestamp: "2024-01-01T00:10:00Z",
  });
  await insertBlock({
    chainId,
    blockNumber: 3,
    timestamp: "2024-01-01T00:15:00Z",
  });
  await insertBlock({
    chainId,
    blockNumber: 4,
    timestamp: "2024-01-01T00:20:00Z",
  });

  await insertStake({
    chainId,
    blockNumber: 1,
    transactionIndex: 0,
    eventIndex: 0,
    emitter: stakerAddress,
    fromAddress: stakerA,
    amount: "100",
    delegate: stakerA,
  });
  await insertStake({
    chainId,
    blockNumber: 2,
    transactionIndex: 0,
    eventIndex: 0,
    emitter: stakerAddress,
    fromAddress: stakerB,
    amount: "300",
    delegate: delegateB,
  });
  await insertWithdrawal({
    chainId,
    blockNumber: 3,
    transactionIndex: 0,
    eventIndex: 0,
    emitter: stakerAddress,
    fromAddress: stakerA,
    amount: "50",
    recipient: stakerA,
    delegate: stakerA,
  });

  await insertProposal({
    chainId,
    blockNumber: 2,
    transactionIndex: 1,
    eventIndex: 0,
    emitter: governorAddress,
    proposalId: "500",
    proposer: stakerA,
  });
  await insertVote({
    chainId,
    blockNumber: 2,
    transactionIndex: 2,
    eventIndex: 0,
    emitter: governorAddress,
    proposalId: "500",
    voter: stakerA,
    weight: "30",
  });
  await insertVote({
    chainId,
    blockNumber: 2,
    transactionIndex: 3,
    eventIndex: 0,
    emitter: governorAddress,
    proposalId: "500",
    voter: delegateB,
    weight: "70",
  });

  const { rows } = await client.query<{
    id: string;
    claimee: string;
    amount: string;
    delegate_portion: string;
    staker_portion: string;
  }>(
    `SELECT id::text AS id,
            claimee,
            amount::text AS amount,
            delegate_portion::text AS delegate_portion,
            staker_portion::text AS staker_portion
     FROM calculate_staker_rewards($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      "2024-01-01T00:05:00Z",
      "2024-01-01T00:20:00Z",
      "1000",
      "3",
      "1",
      chainId,
      stakerAddress,
      governorAddress,
    ]
  );

  expect(rows).toEqual([
    {
      id: "0",
      claimee: "0xa",
      amount: "508",
      delegate_portion: "75",
      staker_portion: "433",
    },
    {
      id: "1",
      claimee: "0xb",
      amount: "316",
      delegate_portion: "0",
      staker_portion: "316",
    },
    {
      id: "2",
      claimee: "0xc",
      amount: "175",
      delegate_portion: "175",
      staker_portion: "0",
    },
  ]);
});

test("calculate_staker_rewards uses the default staker and governor addresses", async () => {
  const {
    rows: [row],
  } = await client.query<{ total: string }>(
    `SELECT SUM(amount)::text AS total
     FROM calculate_staker_rewards($1, $2, $3, $4, $5, $6)`,
    [
      "2024-01-01T00:05:00Z",
      "2024-01-01T00:20:00Z",
      "1000",
      "3",
      "1",
      "23448594291968334",
    ]
  );

  expect(row.total).toBe("999");
});

test("calculate_staker_rewards defaults the chain, staker, and governor addresses", async () => {
  const {
    rows: [row],
  } = await client.query<{ total: string }>(
    `SELECT SUM(amount)::text AS total
     FROM calculate_staker_rewards($1, $2, $3, $4, $5)`,
    ["2024-01-01T00:05:00Z", "2024-01-01T00:20:00Z", "1000", "3", "1"]
  );

  expect(row.total).toBe("999");
});
