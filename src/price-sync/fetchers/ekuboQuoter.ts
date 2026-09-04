import { Effect, Stream } from "effect";
import type { Sql } from "postgres";
import { PriceSyncError, tryPriceSync } from "../errors";
import { fetchJson } from "../http";
import type { LaunchSpacer } from "../launchSpacer";
import type { PriceSyncJob, PriceSyncJobOptions } from "./types";
import { toPriceUpdates } from "./utils";

const SOURCE = "qp1";

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
  // The quoter folds pool fees into price_impact, so a chain whose pools carry
  // an unusually high fee needs a looser cap than the default to report at all.
  maxImpact?: number;
  // Shared by every quoter job in the process, so the request budget is the
  // whole worker's, not one chain's.
  spacer: LaunchSpacer;
  baseUrl: string;
}

function toHexAddress(address: string): `0x${string}` {
  return `0x${BigInt(address).toString(16)}`;
}

function fetchTokensWithTvl(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
): Effect.Effect<TokenRow[], PriceSyncError> {
  return tryPriceSync({
    source: SOURCE,
    operation: `read tokens with TVL for chain ${chainId}`,
    try: () => sql<TokenRow[]>`
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
    `,
  });
}

// Turns a quote into a price, or explains why it is unusable. Separated from
// the request so the "is this quote good enough" rule reads on its own.
function priceFromQuote(
  quote: EkuboQuoteResponse,
  token: TokenRow,
  quoteAmount: bigint,
  maxImpact: number,
): { price: number } | { skipped: string } {
  const priceImpact = Math.max(0, quote.price_impact ?? Infinity);

  if (maxImpact && priceImpact >= maxImpact) {
    return {
      skipped: `price impact ${priceImpact} was g.t.e. max ${maxImpact}`,
    };
  }

  const tokenAmount =
    (Number(quote.total_calculated) * -1) / 10 ** Number(token.token_decimals);
  const price = (Number(quoteAmount) / tokenAmount) * (1 + priceImpact);

  return { price };
}

export function quoterPriceFetcher({
  sql,
  chainId,
  intervalMs,
  address,
  decimals,
  quoteAmount,
  maxImpact = 0.2,
  spacer,
  baseUrl,
}: QuoterPriceFetcherOptions): PriceSyncJob {
  const amountOut = quoteAmount * 10n ** BigInt(decimals);

  // One bad token must not cost the whole cycle: a failed request, or a quote
  // the impact cap rejects, drops that token and leaves the rest of the batch
  // intact -- which is what the try/catch-to-null did, minus swallowing
  // programmer errors along with request failures.
  const quoteToken = Effect.fn("quoter.quoteToken")(function* (token: TokenRow) {
    const url = `${baseUrl}/${chainId}/${-amountOut}/${address}/${toHexAddress(
      token.token_address,
    )}`;

    const quote = yield* spacer(
      fetchJson<EkuboQuoteResponse>({
        source: SOURCE,
        operation: `quote ${token.token_symbol} on chain ${chainId}`,
        url,
        referrer: "https://ekubo.org/",
      }),
    );

    const outcome = priceFromQuote(quote, token, quoteAmount, maxImpact);
    if ("skipped" in outcome) {
      yield* Effect.logWarning(
        `Skipping result for ${token.token_symbol} because ${outcome.skipped}: ${url}`,
      );
      return null;
    }

    if (!outcome.price) return null;

    yield* Effect.logInfo(
      `Found price ${outcome.price} for ${token.token_symbol} (${chainId}:${toHexAddress(
        token.token_address,
      )})`,
    );
    return [token.token_address, outcome.price] as const;
  }, Effect.catch((error) =>
    Effect.logWarning(error.message).pipe(Effect.as(null)),
  ));

  const plan = Effect.fn("quoter.plan")(function* () {
    const tokens = yield* fetchTokensWithTvl(sql, chainId);

    yield* Effect.logInfo(
      `Fetching quoter prices for chain ID ${chainId} tokens: ${tokens
        .map((token) => token.token_symbol)
        .join(", ")}`,
    );

    // Unbounded, as before: the shared spacer is what caps the request rate,
    // and bounding concurrency here would instead stretch each cycle out to
    // the sum of the slowest quotes.
    const quoted = yield* Effect.forEach(tokens, quoteToken, {
      concurrency: "unbounded",
    });

    return toPriceUpdates(
      chainId,
      quoted.filter(
        (price): price is readonly [tokenAddress: string, usdPrice: number] =>
          price !== null,
      ),
    );
  });

  return {
    chainIds: [chainId],
    source: SOURCE,
    intervalMs,
    fetch: Stream.fromEffect(plan()).pipe(
      Stream.filter((updates) => updates.length > 0),
    ),
  };
}
