import type {
  Block as DnaBlock,
  TransactionReceipt as DnaTransactionReceipt,
  TransactionReceiptMeta as DnaTransactionReceiptMeta,
} from "@apibara/starknet";

/**
 * Execution resources exposed by Starknet JSON-RPC receipts.
 *
 * JSON-RPC does not expose DNA's computation-step and builtin counters
 * consistently, so this package intentionally models only gas consumption.
 */
export type StarknetRpcExecutionResources = {
  l1Gas: bigint;
  l1DataGas: bigint;
  l2Gas: bigint;
};

export type StarknetRpcTransactionReceiptMeta = Omit<
  DnaTransactionReceiptMeta,
  "executionResources"
> & {
  executionResources: StarknetRpcExecutionResources;
};

export type StarknetRpcTransactionReceipt = Omit<
  DnaTransactionReceipt,
  "meta"
> & {
  meta: StarknetRpcTransactionReceiptMeta;
};

/** A Starknet block projected from JSON-RPC responses. */
export type StarknetRpcBlock = Omit<DnaBlock, "receipts"> & {
  receipts: StarknetRpcTransactionReceipt[];
};
