export interface PriceUpdate {
  readonly chainId: bigint;
  readonly tokenAddress: `0x${string}`;
  readonly timestamp: Date;
  readonly usdPrice: number;
}

export interface PriceFetcher {
  (): AsyncIterable<readonly PriceUpdate[]>;
}

export interface PriceSyncJob {
  // Chains this job may yield updates for. Per-chain jobs list exactly one; a
  // job that prices the same upstream asset on several chains lists each one so
  // a single request can serve all of them.
  readonly chainIds: readonly bigint[];
  readonly source: string;
  readonly intervalMs: number;
  readonly fetch: PriceFetcher;
}

export interface PriceSyncJobOptions {
  chainId: bigint;
  intervalMs: number;
}
