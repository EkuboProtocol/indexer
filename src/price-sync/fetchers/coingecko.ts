import type { Sql } from "postgres";
import type { PriceSyncJob, PriceSyncJobOptions } from "./types";
import { toPriceUpdates } from "./utils";

const COINGECKO_API_BASE_URL = "https://pro-api.coingecko.com/api/v3";
// Although CoinGecko accepts more addresses, large comma-separated batches can
// exceed the HTTP request-line limit before reaching the API.
const COINGECKO_MAX_CONTRACT_ADDRESSES = 100;

type CoinGeckoTokenPriceResponse = Record<string, { usd?: number }>;
type TokenAddressRow = { token_address: string };

interface CoinGeckoPriceFetcherOptions extends PriceSyncJobOptions {
  sql: Sql<{ bigint: bigint }>;
  platform?: string;
  nativeCoinId?: string;
}

function toEvmAddress(address: string): `0x${string}` {
  return `0x${BigInt(address).toString(16).padStart(40, "0")}`;
}

async function fetchTokenAddresses(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
): Promise<`0x${string}`[]> {
  const tokens = await sql<TokenAddressRow[]>`
    SELECT token_address::TEXT
    FROM erc20_tokens
    WHERE chain_id = ${chainId}
      AND token_address > 0
    ORDER BY token_address
  `;

  return tokens.map(({ token_address }) => toEvmAddress(token_address));
}

async function fetchCoinGecko<T>({
  url,
  apiKey,
  context,
}: {
  url: string;
  apiKey: string;
  context: string;
}): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "x-cg-pro-api-key": apiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `CoinGecko ${context} request failed: ${response.status} ${response.statusText}: ${body}`,
    );
  }

  return (await response.json()) as T;
}

export function coingeckoPriceFetcher({
  sql,
  chainId,
  intervalMs,
  platform,
  nativeCoinId,
}: CoinGeckoPriceFetcherOptions): PriceSyncJob {
  return {
    chainId,
    source: "cg1",
    intervalMs,
    fetch: async function* () {
      const apiKey = process.env.COINGECKO_API_KEY;
      if (!apiKey) {
        throw new Error(
          "COINGECKO_API_KEY is required when CoinGecko price syncing is enabled",
        );
      }

      if (nativeCoinId) {
        const query = new URLSearchParams({
          ids: nativeCoinId,
          vs_currencies: "usd",
          precision: "full",
        });
        const result = await fetchCoinGecko<CoinGeckoTokenPriceResponse>({
          url: `${COINGECKO_API_BASE_URL}/simple/price?${query}`,
          apiKey,
          context: `native token for chain ${chainId}`,
        });
        const nativeUsdPrice = result[nativeCoinId]?.usd;

        if (
          typeof nativeUsdPrice === "number" &&
          Number.isFinite(nativeUsdPrice) &&
          nativeUsdPrice > 0
        ) {
          yield toPriceUpdates(chainId, [["0x0", nativeUsdPrice]]);
        }
      }

      if (platform) {
        const addresses = await fetchTokenAddresses(sql, chainId);

        for (
          let offset = 0;
          offset < addresses.length;
          offset += COINGECKO_MAX_CONTRACT_ADDRESSES
        ) {
          const batch = addresses.slice(
            offset,
            offset + COINGECKO_MAX_CONTRACT_ADDRESSES,
          );
          const query = new URLSearchParams({
            contract_addresses: batch.join(","),
            vs_currencies: "usd",
            precision: "full",
          });
          const result = await fetchCoinGecko<CoinGeckoTokenPriceResponse>({
            url: `${COINGECKO_API_BASE_URL}/simple/token_price/${platform}?${query}`,
            apiKey,
            context: `token prices for chain ${chainId}`,
          });
          const prices: [tokenAddress: string, usdPrice: number][] = [];

          for (const [address, { usd }] of Object.entries(result)) {
            if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
              prices.push([address, usd]);
            }
          }

          const updates = toPriceUpdates(chainId, prices);
          if (updates.length > 0) yield updates;
        }
      }
    },
  };
}
