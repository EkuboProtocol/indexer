import { expect, test } from "bun:test";
import {
  descendingWindows,
  fetchBlockSenders,
  groupByBlock,
  toColumns,
} from "./transactionSenderBackfill";

const hex32 = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(64, "0")}`;

test("groups missing transactions by block, newest first, with padded hashes", () => {
  expect(
    groupByBlock([
      {
        block_number: "5",
        block_hash: "255",
        transaction_index: 1,
        transaction_hash: "16",
      },
      {
        block_number: "9",
        block_hash: "256",
        transaction_index: 0,
        transaction_hash: "17",
      },
      {
        block_number: "5",
        block_hash: "255",
        transaction_index: 3,
        transaction_hash: "18",
      },
    ]),
  ).toEqual([
    {
      blockNumber: 9,
      blockHash: hex32(256),
      transactions: [{ transactionIndex: 0, transactionHash: hex32(17) }],
    },
    {
      blockNumber: 5,
      blockHash: hex32(255),
      transactions: [
        { transactionIndex: 1, transactionHash: hex32(16) },
        { transactionIndex: 3, transactionHash: hex32(18) },
      ],
    },
  ]);
});

test("reads each block once and flattens senders into insert columns", async () => {
  const reads: string[] = [];
  const blocks = groupByBlock([
    {
      block_number: "2",
      block_hash: "2",
      transaction_index: 0,
      transaction_hash: "1",
    },
    {
      block_number: "2",
      block_hash: "2",
      transaction_index: 4,
      transaction_hash: "3",
    },
    {
      block_number: "1",
      block_hash: "1",
      transaction_index: 7,
      transaction_hash: "9",
    },
  ]);
  const senders = await fetchBlockSenders(
    blocks,
    async (blockHash, transactions) => {
      reads.push(blockHash);
      return transactions.map(({ transactionIndex }) => ({
        transactionIndex,
        sender: `0x${(0xa0 + transactionIndex).toString(16)}` as const,
      }));
    },
    4,
  );
  expect(reads).toEqual([hex32(2), hex32(1)]);
  expect(toColumns(senders)).toEqual({
    blockNumbers: ["2", "2", "1"],
    transactionIndexes: [0, 4, 7],
    senders: ["160", "164", "167"],
  });
});

test("walks windows from the newest block down to the first, inclusive", () => {
  expect([...descendingWindows(10, 24, 5)]).toEqual([
    { from: 20, to: 24 },
    { from: 15, to: 19 },
    { from: 10, to: 14 },
  ]);
  expect([...descendingWindows(10, 12, 5)]).toEqual([{ from: 10, to: 12 }]);
  expect([...descendingWindows(10, 9, 5)]).toEqual([]);
});
