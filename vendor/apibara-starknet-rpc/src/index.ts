export { StarknetJsonRpcClient } from "./client";
export type { StarknetRpcClientOptions } from "./client";
export {
  StarknetRpcCapabilityError,
  StarknetRpcError,
  UnsupportedStarknetRpcVersionError,
} from "./errors";
export type { BlockMapper, BlockProduction } from "./block-mapper";
export type { FetchPlan } from "./fetch-plan";
export { FilterSet } from "./filter";
export { StarknetEndpointCapabilities } from "./endpoint-capabilities";
export { StarknetRpcCapabilities, parseSpecVersion } from "./rpc-capabilities";
export type { StarknetRpcSubscriptionCapabilities } from "./rpc-capabilities";
export { StarknetRpcStream } from "./stream-config";
export type { StarknetRpcStreamOptions } from "./stream-config";
export type {
  StarknetRpcBlock,
  StarknetRpcExecutionResources,
  StarknetRpcTransactionReceipt,
  StarknetRpcTransactionReceiptMeta,
} from "./block";

// Re-export the canonical filter vocabulary for convenience.
export type {
  ContractChangeFilter,
  EventFilter,
  Filter,
  HeaderFilter,
  MessageToL1Filter,
  NonceUpdateFilter,
  StorageDiffFilter,
  TransactionFilter,
} from "@apibara/starknet";
export { mergeFilter } from "@apibara/starknet";
