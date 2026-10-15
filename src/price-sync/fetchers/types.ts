import type { Stream } from "effect";
import type { PriceSyncError } from "../errors";

export interface PriceUpdate {
  readonly chainId: bigint;
  readonly tokenAddress: `0x${string}`;
  readonly timestamp: Date;
  readonly usdPrice: number;
  readonly validUntil?: Date;
}

export type PriceFetcher = Stream.Stream<
  readonly PriceUpdate[],
  PriceSyncError
>;

export interface PriceSyncJob {
  readonly chainIds: readonly bigint[];
  readonly source: string;
  readonly intervalMs: number;
  readonly fetch: PriceFetcher;
  readonly resumeFromLastRun?: boolean;
}

export function defaultPriceValidityMs(intervalMs: number): number {
  return Math.max(intervalMs * 3, 60_000);
}

export interface PriceSyncJobOptions {
  chainId: bigint;
  intervalMs: number;
}
