import { EVM_NATIVE_TOKEN_ALIASES } from "./evmNativeTokenAliases";
import Bottleneck from "bottleneck";
import postgres, { type Sql } from "postgres";
import { loadConfig } from "../src/config";
import {
  fetchChainlinkTokenPrices,
  parseChainlinkPriceConfig,
  type ChainlinkPriceObservation,
} from "./chainlinkTokenPrices";

loadConfig();

const sql = postgres(process.env.PG_CONNECTION_STRING!, {
  connect_timeout: 5,
  types: { bigint: postgres.BigInt },
  connection: {
    application_name: `sync-token-prices.ts`,
  },
});

type PriceObservation = number | ChainlinkPriceObservation;
type AddressPriceMap = Record<`0x${string}` | string, PriceObservation>;

type TokenRow = {
  token_address: string;
  token_decimals: number;
  token_symbol: string;
};

type TokenAddressRow = Pick<TokenRow, "token_address">;

const QUOTE_USD_AMOUNT = 1000n;
const EKUBO_QUOTER_BASE_URL =
  process.env.EKUBO_QUOTER_URL ?? "https://prod-api-quoter.ekubo.org";
const COINGECKO_API_BASE_URL = "https://pro-api.coingecko.com/api/v3";
const CHAINLINK_PRICE_CONFIG = parseChainlinkPriceConfig(
  process.env.CHAINLINK_TOKEN_PRICE_CONFIG,
);
// Although CoinGecko accepts more addresses, large comma-separated batches can
// exceed the HTTP request-line limit before reaching the API.
const COINGECKO_MAX_CONTRACT_ADDRESSES = 100;

const COINGECKO_PLATFORM_BY_CHAIN_ID: Record<string, string> = {
  ["8453"]: "base",
  ["4663"]: "robinhood",
  ["42161"]: "arbitrum-one",
};

const COINGECKO_NATIVE_COIN_BY_CHAIN_ID: Record<string, string> = {
  ["1"]: "ethereum",
  ["8453"]: "ethereum",
  ["4663"]: "ethereum",
  ["42161"]: "ethereum",
};

const QUOTE_TOKEN_BY_CHAIN_ID: Record<
  string,
  { address: `0x${string}`; decimals: number }
> = {
  ["1"]: {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
  },
  ["143"]: {
    address: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    decimals: 6,
  },
  // usdg on robinhood chain
  ["4663"]: {
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
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
  (
    sql: Sql<{ bigint: bigint }>,
    chainId: bigint,
  ): AddressPriceMap | Promise<AddressPriceMap>;
}

interface PriceFetcherConfig {
  source: string;
  fetch: PriceFetcher;
}

const sushiswapApiPriceFetcher: PriceFetcher = async (
  _sql,
  chainId: bigint,
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
      `Failed to fetch sushiswap prices for chain ${chainId}: ${response.status} ${response.statusText}`,
    );
  }

  const result = (await response.json()) as AddressPriceMap;

  for (const [key, value] of Object.entries(result)) {
    const numericKey = BigInt(key);

    if (EVM_NATIVE_TOKEN_ALIASES.has(numericKey)) {
      // normalize all known EVM native token aliases to zero address
      delete result[key];
      result["0x0"] = value;
    }
  }

  return result;
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

function toEvmAddress(address: string): `0x${string}` {
  return `0x${BigInt(address).toString(16).padStart(40, "0")}`;
}

function quoteAmountInUnits(decimals: number): bigint {
  return QUOTE_USD_AMOUNT * 10n ** BigInt(decimals);
}

const ekuboQuoterFetchLimiter = new Bottleneck({
  minTime: Math.ceil(
    60_000 / Number(process.env.MAX_QUOTER_REQUESTS_PER_MINUTE ?? 60),
  ),
});

async function fetchTokensWithTvl(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
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
                AND (pk.token0 = t.token_address OR pk.token1 = t.token_address)
                AND (pt.balance0 > 0 OR pt.balance1 > 0))
  `;
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

type CoinGeckoTokenPriceResponse = Record<string, { usd?: number }>;

const coingeckoPriceFetcher: PriceFetcher = async (sql, chainId) => {
  const chainKey = chainId.toString();
  const platform = COINGECKO_PLATFORM_BY_CHAIN_ID[chainKey];
  const nativeCoinId = COINGECKO_NATIVE_COIN_BY_CHAIN_ID[chainKey];
  if (!platform && !nativeCoinId) return {};

  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "COINGECKO_API_KEY is required when CoinGecko price syncing is enabled",
    );
  }

  const prices: AddressPriceMap = {};

  if (nativeCoinId) {
    const query = new URLSearchParams({
      ids: nativeCoinId,
      vs_currencies: "usd",
      precision: "full",
    });
    const url = `${COINGECKO_API_BASE_URL}/simple/price?${query}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "x-cg-pro-api-key": apiKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `CoinGecko native token request failed for chain ${chainId}: ${response.status} ${response.statusText}: ${body}`,
      );
    }

    const result = (await response.json()) as CoinGeckoTokenPriceResponse;
    const nativeUsdPrice = result[nativeCoinId]?.usd;
    if (
      typeof nativeUsdPrice === "number" &&
      Number.isFinite(nativeUsdPrice) &&
      nativeUsdPrice > 0
    ) {
      prices["0x0"] = nativeUsdPrice;
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
      const url = `${COINGECKO_API_BASE_URL}/simple/token_price/${platform}?${query}`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "x-cg-pro-api-key": apiKey,
        },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `CoinGecko request failed for chain ${chainId}: ${response.status} ${response.statusText}: ${body}`,
        );
      }

      const result = (await response.json()) as CoinGeckoTokenPriceResponse;
      for (const [address, { usd }] of Object.entries(result)) {
        if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
          prices[address] = usd;
        }
      }
    }
  }

  return prices;
};

const chainlinkPriceFetcher: PriceFetcher = async (_sql, chainId) => {
  const chainKey = chainId.toString();
  const config = CHAINLINK_PRICE_CONFIG[chainKey];
  if (!config) return {};
  return fetchChainlinkTokenPrices(chainKey, config);
};

async function fetchEkuboQuoterPrice({
  chainId,
  token,
  quoteToken,
  maxImpact = 0.2,
  baseUrl,
}: {
  chainId: bigint;
  token: TokenRow;
  quoteToken: { address: `0x${string}`; decimals: number };
  maxImpact?: number;
  baseUrl: string;
}): Promise<number | null> {
  const amountOut = quoteAmountInUnits(quoteToken.decimals);
  const url = `${baseUrl}${-amountOut}/${quoteToken.address}/${toHexAddress(
    token.token_address,
  )}`;

  try {
    const response = await ekuboQuoterFetchLimiter.schedule(() =>
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

    const basePrice = Number(QUOTE_USD_AMOUNT) / tokenAmount;
    const adjustedPrice = basePrice * (1 + priceImpact);

    return adjustedPrice;
  } catch (error) {
    console.error(
      `JS error while quoting price of ${token.token_symbol} on chain ${chainId}`,
    );
    return null;
  }
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
      .join(", ")}`,
  );

  await Promise.all(
    tokens.map(async (token) => {
      const price = await fetchEkuboQuoterPrice({
        chainId,
        token,
        quoteToken,
        baseUrl: `${EKUBO_QUOTER_BASE_URL}/${chainId}/`,
      });

      if (!price) return;

      console.log(
        `Found price ${price} for ${
          token.token_symbol
        } (${chainId}:${toHexAddress(token.token_address)})`,
      );
      result[token.token_address] = price;
    }),
  );

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
const coingeckoV1PriceFetcher: PriceFetcherConfig = {
  source: "cg1",
  fetch: coingeckoPriceFetcher,
};
const chainlinkV1PriceFetcher: PriceFetcherConfig = {
  source: "cl1",
  fetch: chainlinkPriceFetcher,
};

const FETCHER_BY_CHAIN_ID: { [chainId: string]: PriceFetcherConfig[] } = {
  // eth mainnet
  ["1"]: [sushiswapPriceFetcher, quoterPriceFetcher /*oracleV1PriceFetcher,*/],
  // eth sepolia
  ["11155111"]: [sushiswapPriceFetcher],
  // base
  ["8453"]: [
    quoterPriceFetcher,
    /*oracleV1PriceFetcher,*/ sushiswapPriceFetcher,
  ],
  ["143"]: [quoterPriceFetcher],
  ["4663"]: [quoterPriceFetcher],
  // arbitrum one
  ["42161"]: [sushiswapPriceFetcher],
  // arbitrum sepolia
  ["421614"]: [quoterPriceFetcher],
  // starknet mainnet
  ["23448594291968334"]: [quoterPriceFetcher /*,oracleV1PriceFetcher*/],
  // starknet sepolia
  ["23448594291968335"]: [],
};

const COINGECKO_FETCHER_BY_CHAIN_ID: {
  [chainId: string]: PriceFetcherConfig[];
} = Object.fromEntries(
  [
    ...new Set([
      ...Object.keys(COINGECKO_PLATFORM_BY_CHAIN_ID),
      ...Object.keys(COINGECKO_NATIVE_COIN_BY_CHAIN_ID),
    ]),
  ].map((chainId) => [chainId, [coingeckoV1PriceFetcher]]),
);

const CHAINLINK_FETCHER_BY_CHAIN_ID: {
  [chainId: string]: PriceFetcherConfig[];
} = Object.fromEntries(
  Object.keys(CHAINLINK_PRICE_CONFIG).map((chainId) => [
    chainId,
    [chainlinkV1PriceFetcher],
  ]),
);

function readPositiveInterval(name: string, defaultValue: number): number {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readOptionalIntervalSeconds(name: string): number {
  const value = Number(process.env[name] ?? 0);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

async function syncTokenPricesForChain(
  sql: Sql<{ bigint: bigint }>,
  chainId: string,
  fetchers: PriceFetcherConfig[],
) {
  await sql.begin(async (sql) => {
    const priceRows: [
      chain_id: string,
      token_address: `0x${string}`,
      source: string,
      usd_price: number,
      timestamp: Date | null,
    ][] = [];

    try {
      const priceSnapshots = await Promise.all(
        fetchers.map(async (fetcher) => ({
          source: fetcher.source,
          prices: await fetcher.fetch(sql, BigInt(chainId)),
        })),
      );

      for (const snapshot of priceSnapshots) {
        for (const [tokenAddress, observation] of Object.entries(
          snapshot.prices,
        )) {
          const { usdPrice, timestamp } =
            typeof observation === "number"
              ? { usdPrice: observation, timestamp: null }
              : observation;
          priceRows.push([
            chainId,
            `0x${BigInt(tokenAddress).toString(16)}`,
            snapshot.source,
            usdPrice,
            timestamp,
          ]);
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch prices for chain ID ${chainId}`, e);
      return;
    }

    if (priceRows.length === 0) {
      console.log(`No token prices to insert for chain ID ${chainId}`);
      return;
    }

    let total: number = 0;
    for (let i = 0; i < priceRows.length; i += 1000) {
      const { count } = await sql`
        INSERT INTO erc20_tokens_usd_prices
          (chain_id, token_address, source, value, "timestamp")
        SELECT data.chain_id::int8,
               data.token_address::numeric,
               data.source,
               data.usd_price::double precision,
               COALESCE(data.timestamp::timestamptz, CURRENT_TIMESTAMP)
        FROM (values ${sql(
          priceRows.slice(i, i + 1000),
        )}) as data (chain_id, token_address, source, usd_price, timestamp)
        JOIN erc20_tokens AS t
          ON t.chain_id = data.chain_id::int8
         AND t.token_address = data.token_address::numeric
        WHERE data.timestamp IS NULL
           OR NOT EXISTS (
             SELECT 1
             FROM erc20_tokens_usd_prices existing
             WHERE existing.chain_id = data.chain_id::int8
               AND existing.token_address = data.token_address::numeric
               AND existing.source = data.source
               AND existing."timestamp" = data.timestamp::timestamptz
           );
      `;
      total += count;
    }

    console.log(`Inserted ${total} token price rows for chain ID ${chainId}`);
  });
}

async function main() {
  const runSyncForChain = async (
    chainId: string,
    fetchers: PriceFetcherConfig[],
  ) => {
    const startedAt = Date.now();

    try {
      await syncTokenPricesForChain(sql, chainId, fetchers);
      console.log(
        `Token price sync completed for chain ID ${chainId} in ${Math.round(
          Date.now() - startedAt,
        )} ms`,
      );
    } catch (error) {
      console.error(`Token price sync failed for chain ID ${chainId}`, error);
      process.exit(1);
    }
  };

  let isShuttingDown = false;

  const runSyncLoopForChain = async (
    scheduler: Bottleneck,
    chainId: string,
    fetchers: PriceFetcherConfig[],
  ) => {
    while (!isShuttingDown) {
      try {
        await scheduler.schedule(() => runSyncForChain(chainId, fetchers));
      } catch (error) {
        if (error instanceof Bottleneck.BottleneckError) {
          break;
        }
        console.error(
          `Token price sync loop failed for chain ID ${chainId}`,
          error,
        );
      }
    }
  };

  const chainSchedulers: Bottleneck[] = [];

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    try {
      await Promise.all(
        chainSchedulers.map((l) => l.stop({ dropWaitingJobs: true })),
      );
      // then shutdown the sql connection
      await sql.end({ timeout: 0 });
    } catch (error) {
      console.warn("Failed to shut down cleanly", error);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const defaultIntervalMs = readPositiveInterval(
    "TOKEN_PRICE_SYNC_INTERVAL_MS",
    60_000,
  );
  const coingeckoIntervalSeconds = readOptionalIntervalSeconds(
    "COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS",
  );
  const chainlinkIntervalSeconds = readOptionalIntervalSeconds(
    "CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS",
  );

  const syncJobs = Object.entries(FETCHER_BY_CHAIN_ID).map(
    ([chainId, fetchers]) => ({
      chainId,
      fetchers,
      intervalMs: defaultIntervalMs,
    }),
  );

  if (coingeckoIntervalSeconds > 0) {
    syncJobs.push(
      ...Object.entries(COINGECKO_FETCHER_BY_CHAIN_ID).map(
        ([chainId, fetchers]) => ({
          chainId,
          fetchers,
          intervalMs: coingeckoIntervalSeconds * 1_000,
        }),
      ),
    );
  } else {
    console.log(
      "CoinGecko price syncing is disabled because COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS is 0",
    );
  }

  if (
    chainlinkIntervalSeconds > 0 &&
    Object.keys(CHAINLINK_FETCHER_BY_CHAIN_ID).length > 0
  ) {
    syncJobs.push(
      ...Object.entries(CHAINLINK_FETCHER_BY_CHAIN_ID).map(
        ([chainId, fetchers]) => ({
          chainId,
          fetchers,
          intervalMs: chainlinkIntervalSeconds * 1_000,
        }),
      ),
    );
  } else {
    console.log(
      "Chainlink price syncing is disabled because CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS is 0 or CHAINLINK_TOKEN_PRICE_CONFIG is empty",
    );
  }

  await Promise.all(
    syncJobs.map(({ chainId, fetchers, intervalMs }) => {
      const scheduler = new Bottleneck({
        maxConcurrent: 1,
        minTime: intervalMs,
      });
      chainSchedulers.push(scheduler);
      return runSyncLoopForChain(scheduler, chainId, fetchers);
    }),
  );
}

main().catch(async (error) => {
  console.error("Token price sync worker failed to start", error);
  try {
    await sql.end({ timeout: 0 });
  } finally {
    process.exit(1);
  }
});
