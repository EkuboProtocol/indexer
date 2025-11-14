import "../src/config";
import postgres from "postgres";

type SushiPriceResponse = Record<`0x${string}`, number>;

const SUSHI_PRICE_API_BASE_URL = "https://api.sushi.com/price/v1";

async function fetchPricesForChain(
  chainId: bigint
): Promise<SushiPriceResponse> {
  const url = `${SUSHI_PRICE_API_BASE_URL}/${chainId}`;

  const response = await fetch(url, {
    method: "GET",
    credentials: "omit",
    headers: {
      Accept: "application/json",
    },
    referrer: "https://ekubo.org/",
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch prices for chain ${chainId}: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<SushiPriceResponse>;
}

const sql = postgres(process.env.PG_CONNECTION_STRING, {
  connect_timeout: 5,
  types: { bigint: postgres.BigInt },
});

async function main() {
  await sql.begin(async (sql) => {
    const chainIds = (
      await sql<
        { chain_id: bigint }[]
      >`SELECT chain_id FROM indexer_cursor GROUP BY chain_id;`
    ).map((c) => c.chain_id);

    if (chainIds.length === 0) {
      console.log("No indexers running.");
      return;
    }

    for (const chainId of chainIds.filter((cid) => cid === 1n)) {
      const updates: [
        chain_id: string,
        token_address: string,
        usd_price: number
      ][] = [];

      try {
        const prices = await fetchPricesForChain(chainId);
        // const prices = { ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"]: 1.0 };
        for (const [tokenAddress, usdPrice] of Object.entries(prices)) {
          updates.push([String(chainId), tokenAddress, usdPrice]);
        }
      } catch (e) {
        console.error(`Failed to fetch prices for chain ID ${chainId}`, e);
        continue;
      }

      if (updates.length === 0) {
        console.log(`No token prices to update for chain ID ${chainId}`);
        continue;
      }

      const updatedTokens = await sql`
        UPDATE erc20_tokens AS t
        SET usd_price = data.usd_price::double precision
        FROM (values ${sql(
          updates
        )}) as data (chain_id, token_address, usd_price)
        WHERE t.chain_id = data.chain_id::int8
            AND t.token_address = data.token_address::numeric
        RETURNING t.token_address
      `;

      console.log(
        `Updated ${updatedTokens.length} token prices across [${chainIds
          .map((c) => `${c}`)
          .join(", ")}] chain(s)`
      );
    }
  });
}

main()
  .catch((error) => {
    console.error("Token price sync failed", error);
    process.exit(1);
  })
  .finally(() => sql.end({ timeout: 5 }));
