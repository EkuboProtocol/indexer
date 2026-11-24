import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { numberToHex, type Hex } from "viem";
import { createClient, ensureIndexerCursor } from "../helpers/db";
import { createPgliteDao } from "../helpers/pgliteDao";
import type { DAO } from "../../src/_shared/dao";
import {
  distinctTransactions,
  mapWithConcurrency,
} from "../../src/_shared/transactionSenders";
import { recordEvmTransactionSenders } from "../../src/evm";
import type { StreamBlock } from "../../src/evm/logStream";
import { fetchEvmTransactionSenders } from "../../src/evm/transactionSenders";
import {
  fetchStarknetTransactionSenders,
  recordStarknetTransactionSenders,
  sendersFromBlock,
  starknetSender,
} from "../../src/starknet/transactionSenders";
import type { StarknetStreamBlock } from "../../src/starknet/eventStream";

const CHAIN_ID = 1;

// The error a promise rejects with; a promise that resolves fails the test.
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}
const hex32 = (n: number | bigint): Hex =>
  `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const BLOCK_HASH = hex32(0xb10c);
const OTHER_BLOCK_HASH = hex32(0xb10d);
const txHash = (i: number) => hex32(0x7000 + i);
const sender = (i: number): Hex =>
  `0x${(0xa000 + i).toString(16).padStart(40, "0")}`;

// Answers eth_getTransactionByBlockHashAndIndex for one block; anything else
// throws, so a read that is not pinned to the block hash fails the test.
class FakeEvmRpc {
  calls: unknown[][] = [];
  constructor(
    private readonly transactions: Map<number, Record<string, unknown>>,
  ) {}
  request = (async ({
    method,
    params,
  }: {
    method: string;
    params: unknown[];
  }) => {
    this.calls.push(params);
    if (method !== "eth_getTransactionByBlockHashAndIndex")
      throw new Error(`unexpected ${method}`);
    const [hash, index] = params as [Hex, Hex];
    if (hash !== BLOCK_HASH) return null;
    return this.transactions.get(Number(index)) ?? null;
  }) as never;
}

function evmTransaction(i: number, overrides: Record<string, unknown> = {}) {
  return {
    hash: txHash(i),
    from: sender(i),
    blockHash: BLOCK_HASH,
    transactionIndex: numberToHex(i),
    ...overrides,
  };
}

function evmBlock(transactionIndexes: number[]): StreamBlock {
  return {
    header: {
      blockNumber: 10n,
      blockHash: BLOCK_HASH,
      timestamp: new Date(1_000),
      baseFeePerGas: null,
    },
    logs: transactionIndexes.map((transactionIndex, logIndex) => ({
      address: "0x0000000000000000000000000000000000000c0e",
      topics: [],
      data: "0x",
      transactionHash: txHash(transactionIndex),
      transactionIndex,
      logIndex,
      filterIds: [1],
    })),
  };
}

describe("distinctTransactions", () => {
  test("returns each transaction once, in index order", () => {
    expect(
      distinctTransactions([
        { transactionIndex: 3, transactionHash: txHash(3) },
        { transactionIndex: 1, transactionHash: txHash(1) },
        { transactionIndex: 3, transactionHash: txHash(3) },
      ]),
    ).toEqual([
      { transactionIndex: 1, transactionHash: txHash(1) },
      { transactionIndex: 3, transactionHash: txHash(3) },
    ]);
  });

  test("compares hashes by value, so padding does not matter", () => {
    expect(
      distinctTransactions([
        { transactionIndex: 0, transactionHash: "0x07000" },
        { transactionIndex: 0, transactionHash: txHash(0) },
      ]),
    ).toHaveLength(1);
  });

  test("refuses one index named by two hashes", () => {
    expect(() =>
      distinctTransactions([
        { transactionIndex: 0, transactionHash: txHash(0) },
        { transactionIndex: 0, transactionHash: txHash(1) },
      ]),
    ).toThrow(/two hashes/);
  });
});

test("mapWithConcurrency keeps order and bounds requests in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(n);
    inFlight--;
    return n * 10;
  });
  expect(results).toEqual([50, 10, 40, 20, 30]);
  expect(peak).toBe(2);
});

describe("fetchEvmTransactionSenders", () => {
  const all = new Map([0, 2].map((i) => [i, evmTransaction(i)]));

  test("reads each transaction by block hash and index", async () => {
    const rpc = new FakeEvmRpc(all);
    const senders = await fetchEvmTransactionSenders(
      rpc,
      BLOCK_HASH,
      distinctTransactions(evmBlock([0, 2, 2]).logs),
    );
    expect(senders).toEqual([
      { transactionIndex: 0, sender: sender(0) },
      { transactionIndex: 2, sender: sender(2) },
    ]);
    expect(rpc.calls).toEqual([
      [BLOCK_HASH, "0x0"],
      [BLOCK_HASH, "0x2"],
    ]);
  });

  test("fails when the block is gone", async () => {
    expect(
      (
        await rejection(
          fetchEvmTransactionSenders(new FakeEvmRpc(all), OTHER_BLOCK_HASH, [
            { transactionIndex: 0, transactionHash: txHash(0) },
          ]),
        )
      ).message,
    ).toMatch(/Could not read transaction 0/);
  });

  test("fails when the transaction at the index is not the logged one", async () => {
    const rpc = new FakeEvmRpc(
      new Map([[0, evmTransaction(0, { hash: txHash(9) })]]),
    );
    expect(
      (
        await rejection(
          fetchEvmTransactionSenders(rpc, BLOCK_HASH, [
            { transactionIndex: 0, transactionHash: txHash(0) },
          ]),
        )
      ).message,
    ).toMatch(/but its logs name/);
  });

  test("fails when the node reports another position", async () => {
    const rpc = new FakeEvmRpc(
      new Map([[0, evmTransaction(0, { blockHash: OTHER_BLOCK_HASH })]]),
    );
    expect(
      (
        await rejection(
          fetchEvmTransactionSenders(rpc, BLOCK_HASH, [
            { transactionIndex: 0, transactionHash: txHash(0) },
          ]),
        )
      ).message,
    ).toMatch(/another position/);
  });

  test("fails without a valid from", async () => {
    const rpc = new FakeEvmRpc(
      new Map([[0, evmTransaction(0, { from: "0x1234" })]]),
    );
    expect(
      (
        await rejection(
          fetchEvmTransactionSenders(rpc, BLOCK_HASH, [
            { transactionIndex: 0, transactionHash: txHash(0) },
          ]),
        )
      ).message,
    ).toMatch(/no valid sender/);
  });
});

describe("starknetSender", () => {
  test("takes the sender of INVOKE and DECLARE transactions", () => {
    expect(
      starknetSender({ type: "INVOKE", version: "0x3", sender_address: "0x1" }),
    ).toBe("0x1");
    expect(
      starknetSender({
        type: "INVOKE",
        version: "0x0",
        contract_address: "0x2",
      }),
    ).toBe("0x2");
    expect(starknetSender({ type: "DECLARE", sender_address: "0x3" })).toBe(
      "0x3",
    );
  });

  test("has none for L1 handlers and account deployments", () => {
    expect(
      starknetSender({ type: "L1_HANDLER", contract_address: "0x4" }),
    ).toBeNull();
    expect(starknetSender({ type: "DEPLOY_ACCOUNT" })).toBeNull();
  });
});

describe("Starknet senders from a block", () => {
  const transactions = [
    { transaction_hash: txHash(0), type: "INVOKE", sender_address: "0xa0" },
    {
      transaction_hash: txHash(1),
      type: "L1_HANDLER",
      contract_address: "0xb",
    },
    { transaction_hash: txHash(2), type: "INVOKE", sender_address: "0xa2" },
  ] as const;

  test("skips a transaction without a sender", () => {
    expect(
      sendersFromBlock(BLOCK_HASH, transactions, [
        { transactionIndex: 1, transactionHash: txHash(1) },
        { transactionIndex: 2, transactionHash: txHash(2) },
      ]),
    ).toEqual([{ transactionIndex: 2, sender: "0xa2" }]);
  });

  test("refuses a transaction that is not at its index", () => {
    expect(() =>
      sendersFromBlock(BLOCK_HASH, transactions, [
        { transactionIndex: 0, transactionHash: txHash(2) },
      ]),
    ).toThrow(/but its events name/);
    expect(() =>
      sendersFromBlock(BLOCK_HASH, transactions, [
        { transactionIndex: 5, transactionHash: txHash(5) },
      ]),
    ).toThrow(/has nothing at index 5/);
  });

  test("reads the block by hash and refuses another block", async () => {
    const requests: unknown[] = [];
    const rpc = {
      request: async <T>(method: string, params: unknown) => {
        requests.push([method, params]);
        return { block_hash: OTHER_BLOCK_HASH, transactions } as T;
      },
    };
    expect(
      (
        await rejection(
          fetchStarknetTransactionSenders(rpc, BLOCK_HASH, [
            { transactionIndex: 0, transactionHash: txHash(0) },
          ]),
        )
      ).message,
    ).toMatch(/Could not read the transactions/);
    expect(requests).toEqual([
      ["starknet_getBlockWithTxs", [{ block_hash: BLOCK_HASH }]],
    ]);
  });
});

describe("transaction_senders", () => {
  let client: PGlite;
  let dao: DAO;

  beforeAll(async () => {
    client = await createClient();
    await ensureIndexerCursor(client, CHAIN_ID);
    dao = createPgliteDao(client, BigInt(CHAIN_ID));
  });

  afterAll(async () => {
    await client.close();
  });

  const insertBlock = (blockNumber: number) =>
    client.query(
      `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
       VALUES ($1, $2, $3, now(), 1)`,
      [CHAIN_ID, blockNumber, BigInt(BLOCK_HASH) + BigInt(blockNumber)],
    );

  const rows = async () =>
    (
      await client.query<{
        block_number: string;
        transaction_index: number;
        sender: string;
      }>(
        `SELECT block_number::text, transaction_index, sender::text
         FROM transaction_senders ORDER BY block_number, transaction_index`,
      )
    ).rows;

  test("records each EVM transaction's sender once, and a replay is a no-op", async () => {
    await insertBlock(10);
    const rpc = new FakeEvmRpc(
      new Map([0, 2].map((i) => [i, evmTransaction(i)])),
    );
    await recordEvmTransactionSenders(rpc, dao, evmBlock([0, 2, 2]), 10);
    await recordEvmTransactionSenders(rpc, dao, evmBlock([0, 2]), 10);
    expect(await rows()).toEqual([
      { block_number: "10", transaction_index: 0, sender: String(0xa000) },
      { block_number: "10", transaction_index: 2, sender: String(0xa002) },
    ]);
  });

  test("records Starknet senders and skips transactions without one", async () => {
    await insertBlock(11);
    const rpc = {
      request: async <T>() =>
        ({
          block_hash: BLOCK_HASH,
          transactions: [
            { transaction_hash: txHash(0), type: "L1_HANDLER" },
            {
              transaction_hash: txHash(1),
              type: "INVOKE",
              sender_address: "0x5ca1ab1e",
            },
          ],
        }) as T,
    };
    const block: StarknetStreamBlock = {
      header: {
        blockNumber: 11n,
        blockHash: BLOCK_HASH,
        timestamp: new Date(1_000),
        baseFeePerGas: null,
      },
      logs: [0, 1].map((transactionIndex) => ({
        address: "0x1",
        keys: [],
        data: [],
        transactionHash: txHash(transactionIndex),
        transactionIndex,
        eventIndex: 0,
        filterIds: [1],
      })),
    };
    await recordStarknetTransactionSenders(rpc, dao, block, 11);
    expect((await rows()).filter((r) => r.block_number === "11")).toEqual([
      { block_number: "11", transaction_index: 1, sender: String(0x5ca1ab1e) },
    ]);
  });

  test("refuses updates and cascades away with a rolled-back block", async () => {
    expect(
      (
        await rejection(
          client.query(`UPDATE transaction_senders SET sender = 0`),
        )
      ).message,
    ).toMatch(/Updates are not allowed/);
    await client.query(
      `DELETE FROM blocks WHERE chain_id = $1 AND block_number = 10`,
      [CHAIN_ID],
    );
    expect((await rows()).map((r) => r.block_number)).toEqual(["11"]);
  });
});
