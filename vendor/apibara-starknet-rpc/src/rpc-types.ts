export type JsonRpcId = number | string;

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: T;
  error?: JsonRpcError;
};

export type RpcObject = Record<string, unknown>;

export type RpcBlock = RpcObject & {
  block_hash?: string;
  parent_hash: string;
  block_number?: number;
  new_root?: string;
  timestamp: number;
  sequencer_address?: string;
  starknet_version?: string;
  transactions: unknown[];
};

export type RpcReceipt = RpcObject & {
  transaction_hash: string;
  actual_fee?: unknown;
  execution_status?: string;
  message_hash?: string;
  revert_reason?: string;
  events?: unknown[];
  messages_sent?: unknown[];
  execution_resources?: unknown;
};

export type RpcTransactionWithReceipt = {
  transaction: RpcObject;
  receipt: RpcReceipt;
};

export type RpcBlockWithReceipts = RpcObject & {
  block_hash?: string;
  parent_hash: string;
  block_number?: number;
  new_root?: string;
  timestamp: number;
  sequencer_address?: string;
  starknet_version?: string;
  transactions: RpcTransactionWithReceipt[];
};

export type RpcEventPage = {
  events: RpcObject[];
  continuation_token?: string;
};

export type RpcStateUpdate = RpcObject & {
  block_hash?: string;
  new_root?: string;
  old_root?: string;
  state_diff: RpcObject;
};
