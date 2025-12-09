import "../src/config";
import postgres, { type Sql } from "postgres";

const sql = postgres(process.env.PG_CONNECTION_STRING, {
  connect_timeout: 5,
  types: { bigint: postgres.BigInt },
});

const DEFAULT_SYNC_INTERVAL_MS = 60_000;

type AddressPriceMap = Record<`0x${string}` | string, number>;

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
  ["1"]: [oracleV1PriceFetcher, sushiswapPriceFetcher],
  // eth sepolia
  ["11155111"]: [oracleV1PriceFetcher, sushiswapPriceFetcher],
  // starknet mainnet
  ["23448594291968334"]: [oracleV1PriceFetcher],
  // starknet sepolia
  ["23448594291968335"]: [oracleV1PriceFetcher],
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
