import { Stream } from "effect";
import type { Sql } from "postgres";
import { tryPriceSync } from "../errors";
import type { PriceSyncJob, PriceSyncJobOptions } from "./types";
import { toPriceUpdates } from "./utils";

const SOURCE = "ov1";

interface OracleV1PriceFetcherOptions extends PriceSyncJobOptions {
  sql: Sql<{ bigint: bigint }>;
  usdProxyToken: `0x${string}`;
  oracleExtension: `0x${string}`;
  oracleToken: `0x${string}`;
  twapDurationSeconds: number;
}

export function oracleV1PriceFetcher({
  sql,
  chainId,
  intervalMs,
  usdProxyToken,
  oracleExtension,
  oracleToken,
  twapDurationSeconds,
}: OracleV1PriceFetcherOptions): PriceSyncJob {
  return {
    chainIds: [chainId],
    source: SOURCE,
    intervalMs,
    fetch: Stream.fromEffect(
      tryPriceSync({
        source: SOURCE,
        operation: `oracle prices for chain ${chainId}`,
        try: () => sql<{ token_address: string; usd_price: string }[]>`
          SELECT token_address, usd_price
          FROM get_oracle_usd_prices(
            ${chainId},
            ${BigInt(usdProxyToken).toString()}::numeric,
            ${BigInt(oracleExtension).toString()}::numeric,
            ${BigInt(oracleToken).toString()}::numeric,
            ${twapDurationSeconds}
          )
        `,
      }),
    ).pipe(
      Stream.map((prices) =>
        toPriceUpdates(
          chainId,
          prices.map(
            ({ token_address, usd_price }) =>
              [token_address, Number(usd_price)] as const,
          ),
        ),
      ),
      Stream.filter((updates) => updates.length > 0),
    ),
  };
}
