import "../src/config.js";
import postgres, { type Sql } from "postgres";

const sql = postgres(process.env.PG_CONNECTION_STRING, {
  connect_timeout: 5,
  types: { bigint: postgres.BigInt },
});

type AddressPriceMap = Record<`0x${string}` | string, number>;

interface PriceFetcher {
  (sql: Sql<{ bigint: bigint }>, chainId: bigint):
    | AddressPriceMap
    | Promise<AddressPriceMap>;
}

const sushiswapApiPriceFetcher: PriceFetcher = async (_sql, chainId: bigint) => {
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

const FETCHER_BY_CHAIN_ID: { [chainId: string]: PriceFetcher[] } = {
  // eth mainnet
  ["1"]: [ekuboUsdOraclePriceFetcher, sushiswapApiPriceFetcher],
  // eth sepolia
  ["11155111"]: [ekuboUsdOraclePriceFetcher, sushiswapApiPriceFetcher],
  // starknet mainnet
  ["23448594291968334"]: [ekuboUsdOraclePriceFetcher],
  // starknet sepolia
  ["23448594291968335"]: [ekuboUsdOraclePriceFetcher],
};

function normalizeMapKeys(apm: AddressPriceMap): AddressPriceMap {
  return Object.fromEntries(
    Object.entries(apm).map(([key, value]) => [
      `0x${BigInt(key).toString(16)}`,
      value,
    ])
  );
}

async function main() {
  await sql.begin(async (sql) => {
    for (const chainId of Object.keys(FETCHER_BY_CHAIN_ID)) {
      const fetchers = FETCHER_BY_CHAIN_ID[chainId];

      const updates: [
        chain_id: string,
        token_address: string,
        usd_price: number
      ][] = [];

      try {
        const prices = (
          await Promise.all(
            fetchers.map((fetcher) => fetcher(sql, BigInt(chainId)))
          )
        ).reduce<AddressPriceMap>(
          (memo, value) => ({
            ...normalizeMapKeys(value),
            ...memo,
          }),
          {}
        );

        for (const [tokenAddress, usdPrice] of Object.entries(prices)) {
          updates.push([String(chainId), tokenAddress, usdPrice]);
        }
      } catch (e) {
        console.warn(`Failed to fetch prices for chain ID ${chainId}`, e);
        continue;
      }

      if (updates.length === 0) {
        console.log(`No token prices to update for chain ID ${chainId}`);
        continue;
      }

      const { count } = await sql`
        UPDATE erc20_tokens AS t
        SET usd_price = data.usd_price::double precision
        FROM (values ${sql(
          updates
        )}) as data (chain_id, token_address, usd_price)
        WHERE t.chain_id = data.chain_id::int8
            AND t.token_address = data.token_address::numeric;
      `;

      console.log(`Updated ${count} token prices for chain ID ${chainId}`);
    }
  });
}

main()
  .catch((error) => {
    console.error("Token price sync failed", error);
    process.exit(1);
  })
  .finally(() => sql.end({ timeout: 5 }));
