import { hexToNumber, isAddress, numberToHex, type Hex } from "viem";
import type { TransactionSender } from "../_shared/dao";
import {
  mapWithConcurrency,
  type BlockTransaction,
} from "../_shared/transactionSenders";
import type { RpcLike } from "./logStream";

/** Requests in flight per block. A block rarely has more than a few. */
const CONCURRENCY = 8;

interface RpcTransaction {
  hash?: Hex;
  from?: Hex;
  blockHash?: Hex | null;
  transactionIndex?: Hex | null;
}

/**
 * Each transaction's `from`, read by position from the block with this hash.
 *
 * Reading by block hash and index pins the read to the block whose logs are
 * being written, the same way the MEVCapture v2.1 reads are pinned: a reorg
 * between the log read and this one fails the block, and the runtime retries
 * it, rather than recording a sender from a different block. One request per
 * transaction, about 1.5 kB each, where a full block can be 400 kB.
 */
export async function fetchEvmTransactionSenders(
  rpc: RpcLike,
  blockHash: Hex,
  transactions: readonly BlockTransaction[],
): Promise<TransactionSender[]> {
  return mapWithConcurrency(transactions, CONCURRENCY, async (expected) => {
    const transaction = (await rpc.request({
      method: "eth_getTransactionByBlockHashAndIndex",
      params: [blockHash, numberToHex(expected.transactionIndex)],
    } as never)) as unknown as RpcTransaction | null;
    return {
      transactionIndex: expected.transactionIndex,
      sender: requireSender(transaction, blockHash, expected),
    };
  });
}

export function requireSender(
  transaction: RpcTransaction | null,
  blockHash: Hex,
  expected: BlockTransaction,
): Hex {
  const where = `transaction ${expected.transactionIndex} of block ${blockHash}`;
  if (!transaction) throw new Error(`Could not read ${where}`);
  if (
    !transaction.hash ||
    BigInt(transaction.hash) !== BigInt(expected.transactionHash)
  ) {
    throw new Error(
      `The node returned ${transaction.hash ?? "no hash"} as ${where}, but its logs name ${expected.transactionHash}`,
    );
  }
  if (!atPosition(transaction, blockHash, expected.transactionIndex)) {
    throw new Error(`The node returned ${where} from another position`);
  }
  if (!transaction.from || !isAddress(transaction.from, { strict: false })) {
    throw new Error(`The node returned no valid sender for ${where}`);
  }
  return transaction.from;
}

/** False when the node names another block or index for the transaction. */
function atPosition(
  transaction: RpcTransaction,
  blockHash: Hex,
  transactionIndex: number,
): boolean {
  if (
    transaction.blockHash &&
    BigInt(transaction.blockHash) !== BigInt(blockHash)
  ) {
    return false;
  }
  return (
    !transaction.transactionIndex ||
    hexToNumber(transaction.transactionIndex) === transactionIndex
  );
}
