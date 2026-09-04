import { Stream } from "effect";
import { EVM_NATIVE_TOKEN_ALIASES } from "../../_shared/evmNativeTokenAliases";
import { fetchJson } from "../http";
import type { PriceSyncJob, PriceSyncJobOptions } from "./types";
import { toPriceUpdates } from "./utils";

const SOURCE = "ss1";

// Sushi reports the native currency under one of several sentinel addresses;
// the database keys it as 0x0.
function withNativeAlias(
  prices: Record<string, number>,
): [tokenAddress: string, usdPrice: number][] {
  const result = { ...prices };

  for (const [address, price] of Object.entries(result)) {
    if (EVM_NATIVE_TOKEN_ALIASES.has(BigInt(address))) {
      delete result[address];
      result["0x0"] = price;
    }
  }

  return Object.entries(result);
}

export function sushiswapPriceFetcher({
  chainId,
  intervalMs,
}: PriceSyncJobOptions): PriceSyncJob {
  return {
    chainIds: [chainId],
    source: SOURCE,
    intervalMs,
    fetch: Stream.fromEffect(
      fetchJson<Record<string, number>>({
        source: SOURCE,
        operation: `prices for chain ${chainId}`,
        url: `https://api.sushi.com/price/v1/${chainId}`,
        referrer: "https://ekubo.org/",
      }),
    ).pipe(
      Stream.map((prices) => toPriceUpdates(chainId, withNativeAlias(prices))),
      Stream.filter((updates) => updates.length > 0),
    ),
  };
}
