import { EVM_NATIVE_TOKEN_ALIASES } from "../evmNativeTokenAliases";
import type {
  AddressPriceMap,
  PriceSyncJob,
  PriceSyncJobOptions,
} from "./types";

export function sushiswapPriceFetcher({
  chainId,
  intervalMs,
}: PriceSyncJobOptions): PriceSyncJob {
  return {
    chainId,
    source: "ss1",
    intervalMs,
    fetch: async () => {
      const url = `https://api.sushi.com/price/v1/${chainId}`;
      const response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        headers: {
          Accept: "application/json",
        },
        referrer: "https://ekubo.org/",
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Sushiswap request failed for chain ${chainId}: ${response.status} ${response.statusText}: ${body}`,
        );
      }

      const prices = (await response.json()) as AddressPriceMap;

      for (const [address, price] of Object.entries(prices)) {
        if (EVM_NATIVE_TOKEN_ALIASES.has(BigInt(address))) {
          delete prices[address];
          prices["0x0"] = price;
        }
      }

      return prices;
    },
  };
}
