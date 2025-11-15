import "../src/config";
import postgres, { type Sql } from "postgres";

const sql = postgres(process.env.PG_CONNECTION_STRING, {
  connect_timeout: 5,
  types: { bigint: postgres.BigInt },
});

type AddressPriceMap = Record<`0x${string}`, number>;

interface PriceFetcher {
  (sql: Sql<{ bigint: bigint }>, chainId: bigint):
    | AddressPriceMap
    | Promise<AddressPriceMap>;
}

const sushiswapApiPriceFetcher: PriceFetcher = async (sql, chainId: bigint) => {
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

const ekuboUsdPriceFetcher: PriceFetcher = async (_sql, _chainId) => {
  // todo: compute the prices from the database using oracle snapshots
  return {};
};

const FETCHER_BY_CHAIN_ID: { [chainId: string]: PriceFetcher[] } = {
  // eth mainnet
  ["1"]: [ekuboUsdPriceFetcher, sushiswapApiPriceFetcher],
  // eth sepolia
  ["11155111"]: [ekuboUsdPriceFetcher, sushiswapApiPriceFetcher],
  // starknet mainnet
  ["23448594291968334"]: [ekuboUsdPriceFetcher],
  // starknet sepolia
  ["23448594291968335"]: [ekuboUsdPriceFetcher],
};

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
            ...value,
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
