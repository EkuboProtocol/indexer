import "../src/config";
import postgres, { type Sql } from "postgres";

const sql = postgres(process.env.PG_CONNECTION_STRING!, {
  connect_timeout: 5,
  types: { bigint: postgres.BigInt },
  connection: {
    application_name: `sync-token-prices.ts`,
  },
});

const DEFAULT_SYNC_INTERVAL_MS = 60_000;

type AddressPriceMap = Record<`0x${string}` | string, number>;

type TokenRow = {
  token_address: string;
  token_decimals: number;
  token_symbol: string;
};

const QUOTE_USD_AMOUNT = 1000n;
const EKUBO_QUOTER_BASE_URL =
  process.env.EKUBO_QUOTER_URL ?? "https://prod-api-quoter.ekubo.org";

const QUOTE_TOKEN_BY_CHAIN_ID: Record<
  string,
  { address: `0x${string}`; decimals: number }
> = {
  ["1"]: {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
  },
  ["11155111"]: {
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    decimals: 6,
  },
  ["23448594291968334"]: {
    address:
      "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
    decimals: 6,
  },
  ["23448594291968335"]: {
    address:
      "0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080",
    decimals: 6,
  },
};

interface PriceFetcher {
  (sql: Sql<{ bigint: bigint }>, chainId: bigint):
    | AddressPriceMap
    | Promise<AddressPriceMap>;
}

interface PriceFetcherConfig {
  source: string;
  fetch: PriceFetcher;
}

const sushiswapApiPriceFetcher: PriceFetcher = async (
  _sql,
  chainId: bigint
) => {
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
    console.error(
      `Failed to fetch sushiswap prices for chain ${chainId}: ${response.status} ${response.statusText}`
    );
  }

  const unscaledResult = (await response.json()) as AddressPriceMap;

  return unscaledResult;
};

const ekuboUsdOraclePriceFetcher: PriceFetcher = async (sql, chainId) => {
  let prices: { token_address: string; usd_price: string }[] = [];
  switch (chainId) {
    // mainnet
    case 1n: {
      prices = await sql`
        SELECT token_address, usd_price
        FROM get_oracle_usd_prices(1,
                                  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,
                                  0x51d02A5948496a67827242EaBc5725531342527C,
                                  0x0,
                                  60);
      `;
      break;
    }
    // sepolia
    case 11155111n: {
      prices = await sql`
        SELECT token_address, usd_price
        FROM get_oracle_usd_prices(11155111,
                                  0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238,
                                  0x51d02A5948496a67827242EaBc5725531342527C,
                                  0x0,
                                  60);
      `;
      break;
    }
    // starknet mainnet
    case 0x534e5f4d41494en: {
      prices = await sql`
        SELECT token_address, usd_price
        FROM get_oracle_usd_prices(23448594291968334,
                           0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8,
                           0x005e470ff654d834983a46b8f29dfa99963d5044b993cb7b9c92243a69dab38f,
                           0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87,
                           60);
      `;
      break;
    }
    // starknet sepolia
    case 0x534e5f4d41494fn: {
      prices = await sql`
        SELECT token_address, usd_price
        FROM get_oracle_usd_prices(23448594291968335,
                           0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080,
                           0x003ccf3ee24638dd5f1a51ceb783e120695f53893f6fd947cc2dcabb3f86dc65,
                           0x01fad7c03b2ea7fbef306764e20977f8d4eae6191b3a54e4514cc5fc9d19e569,
                           60);
      `;
      break;
    }
    default: {
      throw new Error(`Unsupported chain ID ${chainId}`);
    }
  }
  return prices.reduce<AddressPriceMap>((memo, value) => {
    memo[value.token_address] = Number(value.usd_price);
    return memo;
  }, {});
};

type EkuboQuoteResponse = { total_calculated: string; price_impact?: number };

function toHexAddress(address: string): `0x${string}` {
  return `0x${BigInt(address).toString(16)}`;
}

function quoteAmountInUnits(decimals: number): bigint {
  return QUOTE_USD_AMOUNT * 10n ** BigInt(decimals);
}

async function fetchTokensWithTvl(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint
): Promise<TokenRow[]> {
  return sql<TokenRow[]>`
SELECT t.token_address::TEXT, t.token_decimals, t.token_symbol
FROM erc20_tokens t
WHERE t.chain_id = ${chainId}
  AND t.visibility_priority >= 0
  AND EXISTS (SELECT 1
              FROM pool_keys pk
                       JOIN pool_tvl pt USING (pool_key_id)
              WHERE pk.chain_id = t.chain_id
                AND (
                  (pk.token0 = t.token_address AND pt.balance0 > 0)
                      OR (pk.token1 = t.token_address AND pt.balance1 > 0)
                  ))
  `;
}

async function fetchEkuboQuoterPrice({
  chainId,
  token,
  quoteToken,
  maxImpact = 0.2,
}: {
  chainId: bigint;
  token: TokenRow;
  quoteToken: { address: `0x${string}`; decimals: number };
  maxImpact?: number;
}): Promise<[`0x${string}`, number] | null> {
  const amountOut = quoteAmountInUnits(quoteToken.decimals);
  const tokenAddressHex = toHexAddress(token.token_address);
  const url = `${EKUBO_QUOTER_BASE_URL}/${chainId.toString()}/${
    chainId === 1n ? "v2/" : ""
  }${-amountOut}/${quoteToken.address}/${tokenAddressHex}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json" },
      referrer: "https://ekubo.org/",
    });

    if (!response.ok) {
      const result = await response.text();
      console.warn(
        `Quoter request failed for ${token.token_symbol}: ${response.status} (${response.statusText}): ${url}; ${result}`
      );
      return null;
    }

    const quote = (await response.json()) as EkuboQuoteResponse;

    const priceImpact = Math.max(0, quote.price_impact ?? Infinity);

    if (maxImpact && priceImpact >= maxImpact) {
      console.warn(
        `Skipping result for ${token.token_symbol} because price impact ${priceImpact} was g.t.e. max ${maxImpact}: ${url}`
      );
      return null;
    }

    const tokenAmount =
      (Number(quote.total_calculated) * -1) /
      10 ** Number(token.token_decimals);

    const basePrice = Number(QUOTE_USD_AMOUNT) / tokenAmount;
    const adjustedPrice = basePrice * (1 + priceImpact);

    return [tokenAddressHex, adjustedPrice];
  } catch (error) {
    console.error(
      `JS error while quoting price of ${token.token_symbol} on chain ${chainId}`
    );
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ekuboQuoterPriceFetcher: PriceFetcher = async (sql, chainId) => {
  const chainKey = chainId.toString();
  const quoteToken = QUOTE_TOKEN_BY_CHAIN_ID[chainKey];
  if (!quoteToken) return {};

  const tokens = await fetchTokensWithTvl(sql, chainId);

  const result: AddressPriceMap = {};

  console.log(
    `Fetching quoter prices for chain ID ${chainId} tokens: ${tokens
      .map((t) => t.token_symbol)
      .join(", ")}`
  );

  for (const token of tokens) {
    const priced = await fetchEkuboQuoterPrice({
      chainId,
      token,
      quoteToken,
    });

    // max 60 requests per minute
    await sleep(1_000);
    if (!priced) continue;

    const [address, price] = priced;
    console.log(
      `Found price ${price} for ${token.token_symbol} (${chainId}:${address})`
    );
    result[address] = price;
  }

  return result;
};

const quoterPriceFetcher: PriceFetcherConfig = {
  source: "qp1",
  fetch: ekuboQuoterPriceFetcher,
};
const oracleV1PriceFetcher: PriceFetcherConfig = {
  source: "ov1",
  fetch: ekuboUsdOraclePriceFetcher,
};

const sushiswapPriceFetcher: PriceFetcherConfig = {
  source: "ss1",
  fetch: sushiswapApiPriceFetcher,
};

const FETCHER_BY_CHAIN_ID: { [chainId: string]: PriceFetcherConfig[] } = {
  // eth mainnet
  ["1"]: [quoterPriceFetcher, /*oracleV1PriceFetcher,*/ sushiswapPriceFetcher],
  // eth sepolia
  ["11155111"]: [sushiswapPriceFetcher],
  // starknet mainnet
  ["23448594291968334"]: [quoterPriceFetcher /*,oracleV1PriceFetcher*/],
  // starknet sepolia
  ["23448594291968335"]: [],
};

function normalizeMapKeys(apm: AddressPriceMap): AddressPriceMap {
  return Object.fromEntries(
    Object.entries(apm).map(([key, value]) => [
      `0x${BigInt(key).toString(16)}`,
      value,
    ])
  );
}

function getSyncInterval(): number {
  const envValue = process.env.TOKEN_PRICE_SYNC_INTERVAL_MS;
  if (envValue === undefined) return DEFAULT_SYNC_INTERVAL_MS;

  const parsed = Number(envValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid TOKEN_PRICE_SYNC_INTERVAL_MS value "${envValue}", expected a positive integer (milliseconds)`
    );
  }

  return parsed;
}

async function syncTokenPrices(sql: Sql<{ bigint: bigint }>) {
  await sql.begin(async (sql) => {
    for (const [chainId, fetchers] of Object.entries(FETCHER_BY_CHAIN_ID)) {
      const priceRows: [
        chain_id: string,
        token_address: string,
        source: string,
        usd_price: number
      ][] = [];

      try {
        const priceSnapshots = await Promise.all(
          fetchers.map(async (fetcher) => ({
            source: fetcher.source,
            prices: await fetcher.fetch(sql, BigInt(chainId)),
          }))
        );

        for (const snapshot of priceSnapshots) {
          for (const [tokenAddress, usdPrice] of Object.entries(
            normalizeMapKeys(snapshot.prices)
          )) {
            priceRows.push([
              String(chainId),
              tokenAddress,
              snapshot.source,
              usdPrice,
            ]);
          }
        }
      } catch (e) {
        console.warn(`Failed to fetch prices for chain ID ${chainId}`, e);
        continue;
      }

      if (priceRows.length === 0) {
        console.log(`No token prices to insert for chain ID ${chainId}`);
        continue;
      }

      let total: number = 0;
      for (let i = 0; i < priceRows.length; i += 1000) {
        const { count } = await sql`
        INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, source, value)
        SELECT data.chain_id::int8,
               data.token_address::numeric,
               data.source,
               data.usd_price::double precision
        FROM (values ${sql(
          priceRows.slice(i, i + 1000)
        )}) as data (chain_id, token_address, source, usd_price)
        JOIN erc20_tokens AS t
          ON t.chain_id = data.chain_id::int8
         AND t.token_address = data.token_address::numeric;
      `;
        total += count;
      }

      console.log(`Inserted ${total} token price rows for chain ID ${chainId}`);
    }
  });
}

async function main() {
  const intervalMs = getSyncInterval();
  let isRunning = false;

  console.log(
    `Starting token price sync worker (interval ${intervalMs.toLocaleString()} ms)`
  );

  const runSync = async () => {
    if (isRunning) {
      console.warn(
        "Previous token price sync still running; skipping this interval"
      );
      return;
    }

    isRunning = true;
    const startedAt = Date.now();

    try {
      await syncTokenPrices(sql);
      console.log(
        `Token price sync completed in ${Math.round(Date.now() - startedAt)} ms`
      );
    } catch (error) {
      console.error("Token price sync failed", error);
      process.exit(1);
    } finally {
      isRunning = false;
    }
  };

  const interval = setInterval(runSync, intervalMs);

  const shutdown = async () => {
    clearInterval(interval);
    try {
      await sql.end({ timeout: 5 });
    } catch (error) {
      console.warn("Failed to close SQL pool cleanly", error);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runSync();
}

main().catch(async (error) => {
  console.error("Token price sync worker failed to start", error);
  try {
    await sql.end({ timeout: 5 });
  } finally {
    process.exit(1);
  }
});
