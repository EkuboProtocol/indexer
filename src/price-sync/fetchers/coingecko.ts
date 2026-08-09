import type { Sql } from "postgres";
import type { PriceSyncJob, PriceSyncJobOptions } from "./types";
import { toPriceUpdates } from "./utils";

const COINGECKO_API_BASE_URL = "https://pro-api.coingecko.com/api/v3";
// Although CoinGecko accepts more addresses, large comma-separated batches can
// exceed the HTTP request-line limit before reaching the API.
const COINGECKO_MAX_CONTRACT_ADDRESSES = 100;
// How long to leave a token out of the rotation after CoinGecko declines to
// price it. Most of `erc20_tokens` is pool scaffolding and one-off deployments
// CoinGecko will never list, so re-asking every cycle costs requests forever
// and never yields a price.
const UNPRICED_REPROBE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type CoinGeckoTokenPriceResponse = Record<string, { usd?: number }>;
type TokenAddressRow = { token_address: string };

interface CoinGeckoPriceFetcherOptions extends PriceSyncJobOptions {
  sql: Sql<{ bigint: bigint }>;
  platform: string;
  unpricedReprobeIntervalMs?: number;
}

interface CoinGeckoNativePriceFetcherOptions {
  intervalMs: number;
  // CoinGecko coin ID to the chains whose native currency it prices. Chains
  // sharing a coin ID are served by one request instead of one apiece.
  chainIdsByCoinId: Readonly<Record<string, readonly bigint[]>>;
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

function requireApiKey(): string {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "COINGECKO_API_KEY is required when CoinGecko price syncing is enabled",
    );
  }
  return apiKey;
}

function usablePrice(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Prices the native currency of every configured chain. Chains that share a
 * CoinGecko coin ID — every EVM rollup settling in ETH, for instance — are
 * priced by a single `simple/price` request rather than one request per chain.
 */
export function coingeckoNativePriceFetcher({
  intervalMs,
  chainIdsByCoinId,
}: CoinGeckoNativePriceFetcherOptions): PriceSyncJob {
  const coinIds = Object.keys(chainIdsByCoinId).sort();
  const chainIds = coinIds.flatMap((coinId) => [...chainIdsByCoinId[coinId]]);

  return {
    chainIds,
    source: "cgn",
    confidence: 2,
    intervalMs,
    fetch: async function* () {
      if (coinIds.length === 0) return;

      const apiKey = requireApiKey();
      const query = new URLSearchParams({
        ids: coinIds.join(","),
        vs_currencies: "usd",
        precision: "full",
      });
      const result = await fetchCoinGecko<CoinGeckoTokenPriceResponse>({
        url: `${COINGECKO_API_BASE_URL}/simple/price?${query}`,
        apiKey,
        context: `native currencies ${coinIds.join(", ")}`,
      });

      const timestamp = new Date();
      for (const coinId of coinIds) {
        const usdPrice = result[coinId]?.usd;
        if (!usablePrice(usdPrice)) continue;

        for (const chainId of chainIdsByCoinId[coinId]) {
          yield toPriceUpdates(chainId, [["0x0", usdPrice]], timestamp);
        }
      }
    },
  };
}

/**
 * Prices a chain's ERC20 tokens by contract address.
 *
 * Only tokens CoinGecko has actually priced are requested every cycle. The rest
 * — the large majority of `erc20_tokens` on any chain — are re-probed on a slow
 * rotation, which keeps request volume proportional to the tokens CoinGecko
 * covers instead of to the size of the table.
 */
export function coingeckoPriceFetcher({
  sql,
  chainId,
  intervalMs,
  platform,
  unpricedReprobeIntervalMs = UNPRICED_REPROBE_INTERVAL_MS,
}: CoinGeckoPriceFetcherOptions): PriceSyncJob {
  // Retained across cycles for the life of the process. A restart replays the
  // full sweep once, which is what this job did on every cycle before.
  const priced = new Set<string>();
  const probed = new Set<string>();
  let cycle = 0;

  // Spread the re-probes of unpriced tokens evenly across the rotation window,
  // so each cycle carries roughly one slot's worth instead of the whole tail.
  const slotCount = Math.max(
    1,
    Math.round(unpricedReprobeIntervalMs / Math.max(intervalMs, 1)),
  );

  return {
    chainIds: [chainId],
    source: "cg1",
    confidence: 2,
    intervalMs,
    fetch: async function* () {
      const apiKey = requireApiKey();
      const addresses = await fetchTokenAddresses(sql, chainId);
      const currentAddresses = new Set(addresses);

      // Tokens can leave `erc20_tokens`; do not let the sets grow forever.
      for (const address of probed) {
        if (!currentAddresses.has(address)) {
          probed.delete(address);
          priced.delete(address);
        }
      }

      const slot = cycle % slotCount;
      cycle++;

      const selected = addresses.filter(
        (address, index) =>
          // CoinGecko prices it, so keep it fresh every cycle.
          priced.has(address) ||
          // Never asked — a token new to the table, or the first sweep after a
          // restart.
          !probed.has(address) ||
          // Due for its periodic re-probe in case CoinGecko has listed it since.
          index % slotCount === slot,
      );

      for (
        let offset = 0;
        offset < selected.length;
        offset += COINGECKO_MAX_CONTRACT_ADDRESSES
      ) {
        const batch = selected.slice(
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

        // CoinGecko lowercases the addresses it echoes back, so compare on the
        // requested form rather than trusting the response keys to match.
        const pricedInBatch = new Set<string>();
        for (const [address, { usd }] of Object.entries(result)) {
          if (usablePrice(usd)) {
            prices.push([address, usd]);
            pricedInBatch.add(address.toLowerCase());
          }
        }

        for (const address of batch) {
          probed.add(address);
          if (pricedInBatch.has(address.toLowerCase())) {
            priced.add(address);
          } else {
            priced.delete(address);
          }
        }

        const updates = toPriceUpdates(chainId, prices);
        if (updates.length > 0) yield updates;
      }
    },
  };
}
