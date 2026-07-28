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
  readonly chainId: bigint;
  readonly source: string;
  readonly intervalMs: number;
  readonly fetch: PriceFetcher;
}

export interface PriceSyncJobOptions {
  chainId: bigint;
  intervalMs: number;
}
