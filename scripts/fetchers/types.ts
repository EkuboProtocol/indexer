import type { Sql } from "postgres";

export type AddressPriceMap = Record<string, number>;

export interface PriceFetcher {
  (sql: Sql<{ bigint: bigint }>): AddressPriceMap | Promise<AddressPriceMap>;
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
