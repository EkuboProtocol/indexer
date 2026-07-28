import type { Sql } from "postgres";
import type { PriceSyncJob, PriceSyncJobOptions } from "./types";
import { toPriceUpdates } from "./utils";

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
    chainId,
    source: "ov1",
    intervalMs,
    fetch: async function* () {
      const prices = await sql<{ token_address: string; usd_price: string }[]>`
        SELECT token_address, usd_price
        FROM get_oracle_usd_prices(
          ${chainId},
          ${BigInt(usdProxyToken).toString()}::numeric,
          ${BigInt(oracleExtension).toString()}::numeric,
          ${BigInt(oracleToken).toString()}::numeric,
          ${twapDurationSeconds}
        )
      `;

      const updates = toPriceUpdates(
        chainId,
        prices.map(
          ({ token_address, usd_price }) =>
            [token_address, Number(usd_price)] as const,
        ),
      );
      if (updates.length > 0) yield updates;
    },
  };
}
