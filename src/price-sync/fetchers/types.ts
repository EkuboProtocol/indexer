export interface PriceUpdate {
  readonly chainId: bigint;
  readonly tokenAddress: `0x${string}`;
  readonly timestamp: Date;
  readonly usdPrice: number;
  // How long this observation may serve as a latest price. Fetchers with a
  // source-native staleness contract (e.g. Chainlink heartbeats) set it
  // per row; others leave it unset and get the job's default validity.
  readonly validUntil?: Date;
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

// Default validity stamped on observations that carry no horizon of their own:
// three sync intervals keeps a price usable across two missed runs, with a
// one-minute floor for deliberately aggressive development cadences.
export function defaultPriceValidityMs(intervalMs: number): number {
  return Math.max(intervalMs * 3, 60_000);
}

export interface PriceSyncJobOptions {
  chainId: bigint;
  intervalMs: number;
}
