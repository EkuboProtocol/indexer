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
  // Higher confidence wins in the latest-price cache; sources tied at the
  // highest confidence are averaged. Published to erc20_token_price_sources at
  // startup so source policy lives in one place.
  readonly confidence: number;
  readonly intervalMs: number;
  readonly fetch: PriceFetcher;
}

// Keep an observation usable across two missed runs, with a one-minute floor
// for deliberately aggressive development cadences.
export function priceSourceFreshnessMs(intervalMs: number): number {
  return Math.max(intervalMs * 3, 60_000);
}

export interface PriceSyncJobOptions {
  chainId: bigint;
  intervalMs: number;
}
