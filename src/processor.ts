export interface EventKey {
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  emitter: bigint;
  transactionHash: bigint;
}
