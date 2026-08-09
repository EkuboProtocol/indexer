import Bottleneck from "bottleneck";
import type { Sql } from "postgres";
import type { PriceSyncJob, PriceSyncJobOptions } from "./types";
import { toPriceUpdates } from "./utils";

type TokenRow = {
  token_address: string;
  token_decimals: number;
  token_symbol: string;
};

type EkuboQuoteResponse = {
  total_calculated: string;
  price_impact?: number;
};

interface QuoterPriceFetcherOptions extends PriceSyncJobOptions {
  sql: Sql<{ bigint: bigint }>;
  address: `0x${string}`;
  decimals: number;
  quoteAmount: bigint;
}

let ekuboQuoterFetchLimiter: Bottleneck | undefined;

function getEkuboQuoterFetchLimiter(): Bottleneck {
  if (ekuboQuoterFetchLimiter) return ekuboQuoterFetchLimiter;

  const maxRequestsPerMinute = Number(
    process.env.MAX_QUOTER_REQUESTS_PER_MINUTE ?? 60,
  );
  if (
    !Number.isFinite(maxRequestsPerMinute) ||
    !Number.isInteger(maxRequestsPerMinute) ||
    maxRequestsPerMinute <= 0
  ) {
    throw new Error(
      "MAX_QUOTER_REQUESTS_PER_MINUTE must be a positive integer",
    );
  }

  ekuboQuoterFetchLimiter = new Bottleneck({
    minTime: Math.ceil(60_000 / maxRequestsPerMinute),
  });
  return ekuboQuoterFetchLimiter;
}

function toHexAddress(address: string): `0x${string}` {
  return `0x${BigInt(address).toString(16)}`;
}

async function fetchTokensWithTvl(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
): Promise<TokenRow[]> {
  return sql<TokenRow[]>`
    SELECT t.token_address::TEXT, t.token_decimals, t.token_symbol
    FROM erc20_tokens t
    WHERE t.chain_id = ${chainId}
      AND t.visibility_priority >= 0
      AND EXISTS (
        SELECT 1
        FROM pool_keys pk
        JOIN pool_tvl pt USING (pool_key_id)
        WHERE pk.chain_id = t.chain_id
          AND (
            pk.token0 = t.token_address
            OR pk.token1 = t.token_address
          )
          AND (pt.balance0 > 0 OR pt.balance1 > 0)
      )
  `;
}

async function fetchEkuboQuoterPrice({
  chainId,
  token,
  address,
  decimals,
  quoteAmount,
  maxImpact = 0.2,
  baseUrl,
}: {
  chainId: bigint;
  token: TokenRow;
  address: `0x${string}`;
  decimals: number;
  quoteAmount: bigint;
  maxImpact?: number;
  baseUrl: string;
}): Promise<number | null> {
  const amountOut = quoteAmount * 10n ** BigInt(decimals);
  const url = `${baseUrl}${-amountOut}/${address}/${toHexAddress(
    token.token_address,
  )}`;

  try {
    const response = await getEkuboQuoterFetchLimiter().schedule(() =>
      fetch(url, {
        method: "GET",
        credentials: "omit",
        headers: { Accept: "application/json" },
        referrer: "https://ekubo.org/",
      }),
    );

    if (!response.ok) {
      const result = await response.text();
      console.warn(
        `Quoter request failed for ${token.token_symbol}: ${response.status} (${response.statusText}): ${url}; ${result}`,
      );
      return null;
    }

    const quote = (await response.json()) as EkuboQuoteResponse;
    const priceImpact = Math.max(0, quote.price_impact ?? Infinity);

    if (maxImpact && priceImpact >= maxImpact) {
      console.warn(
        `Skipping result for ${token.token_symbol} because price impact ${priceImpact} was g.t.e. max ${maxImpact}: ${url}`,
      );
      return null;
    }

    const tokenAmount =
      (Number(quote.total_calculated) * -1) /
      10 ** Number(token.token_decimals);
    const basePrice = Number(quoteAmount) / tokenAmount;

    return basePrice * (1 + priceImpact);
  } catch (error) {
    console.error(
      `JS error while quoting price of ${token.token_symbol} on chain ${chainId}`,
      error,
    );
    return null;
  }
}

export function quoterPriceFetcher({
  sql,
  chainId,
  intervalMs,
  address,
  decimals,
  quoteAmount,
}: QuoterPriceFetcherOptions): PriceSyncJob {
  const quoterBaseUrl = (
    process.env.EKUBO_QUOTER_URL ?? "https://prod-api-quoter.ekubo.org"
  ).replace(/\/+$/, "");

  return {
    chainIds: [chainId],
    source: "qp1",
    intervalMs,
    fetch: async function* () {
      const tokens = await fetchTokensWithTvl(sql, chainId);

      console.log(
        `Fetching quoter prices for chain ID ${chainId} tokens: ${tokens
          .map((token) => token.token_symbol)
          .join(", ")}`,
      );

      const prices = (
        await Promise.all(
          tokens.map(async (token) => {
            const price = await fetchEkuboQuoterPrice({
              chainId,
              token,
              address,
              decimals,
              quoteAmount,
              baseUrl: `${quoterBaseUrl}/${chainId}/`,
            });

            if (!price) return null;

            console.log(
              `Found price ${price} for ${
                token.token_symbol
              } (${chainId}:${toHexAddress(token.token_address)})`,
            );
            return [token.token_address, price] as const;
          }),
        )
      ).filter(
        (price): price is readonly [tokenAddress: string, usdPrice: number] =>
          price !== null,
      );

      const updates = toPriceUpdates(chainId, prices);
      if (updates.length > 0) yield updates;
    },
  };
}
