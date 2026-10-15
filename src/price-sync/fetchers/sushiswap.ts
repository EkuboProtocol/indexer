import { Stream } from "effect";
import { EVM_NATIVE_TOKEN_ALIASES } from "../../_shared/evmNativeTokenAliases";
import { fetchJson } from "../http";
import type { PriceSyncJob, PriceSyncJobOptions } from "./types";
import { toPriceUpdates } from "./utils";

const SOURCE = "ss1";

interface SushiswapPriceFetcherOptions extends PriceSyncJobOptions {
  wrappedNative?: `0x${string}`;
}

function withNativeAlias(
  prices: Record<string, number>,
  wrappedNative: `0x${string}` | undefined,
): [tokenAddress: string, usdPrice: number][] {
  const result = { ...prices };

  for (const [address, price] of Object.entries(result)) {
    if (EVM_NATIVE_TOKEN_ALIASES.has(BigInt(address))) {
      delete result[address];
      result["0x0"] = price;
    }
  }

  if (wrappedNative !== undefined && !("0x0" in result)) {
    const wrapped = BigInt(wrappedNative);
    const entry = Object.entries(result).find(
      ([address]) => BigInt(address) === wrapped,
    );
    if (entry) result["0x0"] = entry[1];
  }

  return Object.entries(result);
}

export function sushiswapPriceFetcher({
  chainId,
  intervalMs,
  wrappedNative,
}: SushiswapPriceFetcherOptions): PriceSyncJob {
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
      Stream.map((prices) =>
        toPriceUpdates(chainId, withNativeAlias(prices, wrappedNative)),
      ),
      Stream.filter((updates) => updates.length > 0),
    ),
  };
}
