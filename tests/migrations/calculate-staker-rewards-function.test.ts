import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "00001_chain_tables",
  "00012_governance_tables",
  "00099_calculate_staker_rewards_function",
] as const;

let client: PGlite;

const DEFAULT_CHAIN_ID = "23448594291968334";
const DEFAULT_STAKER_ADDRESS =
  "1194257563955965460367353409140405763780761879270528111624067674852467116981";
const DEFAULT_GOVERNOR_ADDRESS =
  "2354502934501836923955011505963489193673442986857363336683304411560511969997";

beforeEach(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterEach(async () => {
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

async function queryRewards(params: Array<string>) {
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
     FROM calculate_staker_rewards(${params.map((_, i) => `$${i + 1}`).join(", ")})`,
    params
  );

  return rows;
}

async function seedDefaultScenario() {
  const chainId = DEFAULT_CHAIN_ID;
  const stakerAddress = DEFAULT_STAKER_ADDRESS;
  const governorAddress = DEFAULT_GOVERNOR_ADDRESS;
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
}

test("calculate_staker_rewards distributes combined staker and delegate rewards correctly", async () => {
  await seedDefaultScenario();

  const rows = await queryRewards([
    "2024-01-01T00:05:00Z",
    "2024-01-01T00:20:00Z",
    "1000",
    "3",
    "1",
    DEFAULT_CHAIN_ID,
    DEFAULT_STAKER_ADDRESS,
    DEFAULT_GOVERNOR_ADDRESS,
  ]);

  expect(rows).toEqual([
    {
      id: "0",
      claimee: "0xa",
      amount: "423",
      delegate_portion: "75",
      staker_portion: "348",
    },
    {
      id: "1",
      claimee: "0xb",
      amount: "401",
      delegate_portion: "0",
      staker_portion: "401",
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

test("numeric_to_hex formats zero as 0x0", async () => {
  const {
    rows: [row],
  } = await client.query<{ value: string }>(
    `SELECT numeric_to_hex(0) AS value`
  );

  expect(row.value).toBe("0x0");
});

test("staking rewards use pre-window balances without double-counting", async () => {
  const chainId = DEFAULT_CHAIN_ID;
  const stakerAddress = DEFAULT_STAKER_ADDRESS;

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
    timestamp: "2024-01-01T00:20:00Z",
  });

  await insertStake({
    chainId,
    blockNumber: 1,
    transactionIndex: 0,
    eventIndex: 0,
    emitter: stakerAddress,
    fromAddress: "10",
    amount: "100",
    delegate: "10",
  });
  await insertStake({
    chainId,
    blockNumber: 2,
    transactionIndex: 0,
    eventIndex: 0,
    emitter: stakerAddress,
    fromAddress: "11",
    amount: "300",
    delegate: "11",
  });

  const rows = await queryRewards([
    "2024-01-01T00:05:00Z",
    "2024-01-01T00:20:00Z",
    "400",
    "1",
    "0",
    chainId,
    stakerAddress,
    DEFAULT_GOVERNOR_ADDRESS,
  ]);

  expect(rows).toEqual([
    {
      id: "0",
      claimee: "0xb",
      amount: "200",
      delegate_portion: "0",
      staker_portion: "200",
    },
    {
      id: "1",
      claimee: "0xa",
      amount: "199",
      delegate_portion: "0",
      staker_portion: "199",
    },
  ]);
});

test("delegate rewards are selected by proposal timestamps rather than vote timestamps", async () => {
  const chainId = DEFAULT_CHAIN_ID;
  const governorAddress = DEFAULT_GOVERNOR_ADDRESS;

  await insertBlock({
    chainId,
    blockNumber: 1,
    timestamp: "2024-01-01T00:05:00Z",
  });
  await insertBlock({
    chainId,
    blockNumber: 2,
    timestamp: "2024-01-01T00:12:00Z",
  });
  await insertBlock({
    chainId,
    blockNumber: 3,
    timestamp: "2024-01-01T00:15:00Z",
  });
  await insertBlock({
    chainId,
    blockNumber: 4,
    timestamp: "2024-01-01T00:25:00Z",
  });

  await insertProposal({
    chainId,
    blockNumber: 1,
    transactionIndex: 0,
    eventIndex: 0,
    emitter: governorAddress,
    proposalId: "500",
    proposer: "10",
  });
  await insertVote({
    chainId,
    blockNumber: 3,
    transactionIndex: 0,
    eventIndex: 0,
    emitter: governorAddress,
    proposalId: "500",
    voter: "10",
    weight: "100",
  });

  await insertProposal({
    chainId,
    blockNumber: 2,
    transactionIndex: 1,
    eventIndex: 0,
    emitter: governorAddress,
    proposalId: "501",
    proposer: "11",
  });
  await insertVote({
    chainId,
    blockNumber: 4,
    transactionIndex: 0,
    eventIndex: 0,
    emitter: governorAddress,
    proposalId: "501",
    voter: "12",
    weight: "300",
  });

  const rows = await queryRewards([
    "2024-01-01T00:10:00Z",
    "2024-01-01T00:20:00Z",
    "400",
    "0",
    "1",
    chainId,
    DEFAULT_STAKER_ADDRESS,
    governorAddress,
  ]);

  expect(rows).toEqual([
    {
      id: "0",
      claimee: "0xc",
      amount: "400",
      delegate_portion: "400",
      staker_portion: "0",
    },
  ]);
});

test("calculate_staker_rewards ignores events from other chains", async () => {
  await seedDefaultScenario();

  const otherChainId = "999";
  await insertBlock({
    chainId: otherChainId,
    blockNumber: 1,
    timestamp: "2024-01-01T00:10:00Z",
  });
  await insertStake({
    chainId: otherChainId,
    blockNumber: 1,
    transactionIndex: 0,
    eventIndex: 0,
    emitter: DEFAULT_STAKER_ADDRESS,
    fromAddress: "255",
    amount: "1000000",
    delegate: "255",
  });
  await insertProposal({
    chainId: otherChainId,
    blockNumber: 1,
    transactionIndex: 1,
    eventIndex: 0,
    emitter: DEFAULT_GOVERNOR_ADDRESS,
    proposalId: "700",
    proposer: "255",
  });
  await insertVote({
    chainId: otherChainId,
    blockNumber: 1,
    transactionIndex: 2,
    eventIndex: 0,
    emitter: DEFAULT_GOVERNOR_ADDRESS,
    proposalId: "700",
    voter: "255",
    weight: "1000000",
  });

  const rows = await queryRewards([
    "2024-01-01T00:05:00Z",
    "2024-01-01T00:20:00Z",
    "1000",
    "3",
    "1",
    DEFAULT_CHAIN_ID,
    DEFAULT_STAKER_ADDRESS,
    DEFAULT_GOVERNOR_ADDRESS,
  ]);

  expect(rows).toEqual([
    {
      id: "0",
      claimee: "0xa",
      amount: "423",
      delegate_portion: "75",
      staker_portion: "348",
    },
    {
      id: "1",
      claimee: "0xb",
      amount: "401",
      delegate_portion: "0",
      staker_portion: "401",
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
  await seedDefaultScenario();

  const {
    rows: [row],
  } = await client.query<{ total: string }>(
    `SELECT SUM(amount)::text AS total
     FROM calculate_staker_rewards($1, $2, $3, $4, $5, $6)`,
    ["2024-01-01T00:05:00Z", "2024-01-01T00:20:00Z", "1000", "3", "1", DEFAULT_CHAIN_ID]
  );

  expect(row.total).toBe("999");
});

test("calculate_staker_rewards defaults the chain, staker, and governor addresses", async () => {
  await seedDefaultScenario();

  const {
    rows: [row],
  } = await client.query<{ total: string }>(
    `SELECT SUM(amount)::text AS total
     FROM calculate_staker_rewards($1, $2, $3, $4, $5)`,
    ["2024-01-01T00:05:00Z", "2024-01-01T00:20:00Z", "1000", "3", "1"]
  );

  expect(row.total).toBe("999");
});
