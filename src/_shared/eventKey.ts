export interface EventKey {
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  emitter: `0x${string}`;
  transactionHash: `0x${string}`;
}

export function hexToNumericString(value: `0x${string}`): string {
  return BigInt(value).toString();
}
