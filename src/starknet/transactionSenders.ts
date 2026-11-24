import type { Hex } from "viem";
import type { DAO, TransactionSender } from "../_shared/dao";
import {
  distinctTransactions,
  type BlockTransaction,
} from "../_shared/transactionSenders";
import type { StarknetRpc, StarknetStreamBlock } from "./eventStream";

export interface StarknetBlockTransaction {
  transaction_hash?: Hex;
  type?: string;
  version?: Hex;
  sender_address?: Hex;
  contract_address?: Hex;
}

interface StarknetBlockWithTxs {
  block_hash?: Hex;
  transactions?: StarknetBlockTransaction[];
}

/**
 * The account that sent the transaction, or null for a type without one.
 *
 * INVOKE v1 and v3 and DECLARE carry `sender_address`. INVOKE v0 named the
 * account it called as `contract_address`. L1_HANDLER's `contract_address` is
 * the L2 target, not a sender, and DEPLOY_ACCOUNT carries no address at all.
 */
export function starknetSender(
  transaction: StarknetBlockTransaction,
): Hex | null {
  switch (transaction.type) {
    case "INVOKE":
      return transaction.sender_address ?? transaction.contract_address ?? null;
    case "DECLARE":
      return transaction.sender_address ?? null;
    default:
      return null;
  }
}

/**
 * The senders of the given transactions, from the block with this hash.
 *
 * One `starknet_getBlockWithTxs` per block, pinned to the hash whose events are
 * being written: it costs what one transaction read costs, and a Starknet
 * block with Ekubo events has about four of them. A block that changed hash
 * fails, and the runtime retries it.
 */
export async function fetchStarknetTransactionSenders(
  rpc: StarknetRpc,
  blockHash: Hex,
  transactions: readonly BlockTransaction[],
): Promise<TransactionSender[]> {
  const block = await rpc.request<StarknetBlockWithTxs | null>(
    "starknet_getBlockWithTxs",
    [{ block_hash: blockHash }],
  );
  if (!block?.block_hash || BigInt(block.block_hash) !== BigInt(blockHash)) {
    throw new Error(`Could not read the transactions of block ${blockHash}`);
  }
  return sendersFromBlock(blockHash, block.transactions ?? [], transactions);
}

/** The sender of every transaction with an indexed event in the block (00142). */
export async function recordStarknetTransactionSenders(
  rpc: StarknetRpc,
  dao: DAO,
  block: StarknetStreamBlock,
  blockNumber: number,
): Promise<void> {
  const transactions = distinctTransactions(block.logs);
  if (transactions.length === 0) return;
  await dao.insertTransactionSenders(
    blockNumber,
    await fetchStarknetTransactionSenders(
      rpc,
      block.header.blockHash,
      transactions,
    ),
  );
}

export function sendersFromBlock(
  blockHash: Hex,
  blockTransactions: readonly StarknetBlockTransaction[],
  transactions: readonly BlockTransaction[],
): TransactionSender[] {
  const senders: TransactionSender[] = [];
  for (const expected of transactions) {
    const transaction = blockTransactions[expected.transactionIndex];
    if (
      !transaction?.transaction_hash ||
      BigInt(transaction.transaction_hash) !== BigInt(expected.transactionHash)
    ) {
      throw new Error(
        `Block ${blockHash} has ${transaction?.transaction_hash ?? "nothing"} at index ${expected.transactionIndex}, but its events name ${expected.transactionHash}`,
      );
    }
    const sender = starknetSender(transaction);
    if (sender !== null) {
      senders.push({ transactionIndex: expected.transactionIndex, sender });
    }
  }
  return senders;
}
