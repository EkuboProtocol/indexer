import type {
  AddressPriceMap,
  PriceSyncJob,
  PriceSyncJobOptions,
} from "./types";

interface OracleV1PriceFetcherOptions extends PriceSyncJobOptions {
  usdProxyToken: `0x${string}`;
  oracleExtension: `0x${string}`;
  oracleToken: `0x${string}`;
  twapDurationSeconds: number;
}

export function oracleV1PriceFetcher({
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
    fetch: async (sql) => {
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

      return prices.reduce<AddressPriceMap>((result, price) => {
        result[price.token_address] = Number(price.usd_price);
        return result;
      }, {});
    },
  };
}
