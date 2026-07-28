import type { Sql } from "postgres";
import type { PriceUpdate } from "./fetchers/types";

const INSERT_BATCH_SIZE = 1_000;

type PriceRow = [
  chainId: string,
  tokenAddress: string,
  timestamp: string,
  source: string,
  usdPrice: number,
];

function toPriceRow(source: string, update: PriceUpdate): PriceRow {
  if (!Number.isFinite(update.usdPrice) || update.usdPrice <= 0) {
    throw new Error(`Invalid USD price: ${update.usdPrice}`);
  }
  if (Number.isNaN(update.timestamp.getTime())) {
    throw new Error("Invalid price update timestamp");
  }

  return [
    update.chainId.toString(),
    BigInt(update.tokenAddress).toString(),
    update.timestamp.toISOString(),
    source,
    update.usdPrice,
  ];
}

export async function persistPriceUpdates(
  sql: Sql<{ bigint: bigint }>,
  source: string,
  updates: readonly PriceUpdate[],
): Promise<number> {
  if (updates.length === 0) return 0;

  const rows = updates.map((update) => toPriceRow(source, update));
  let insertedCount = 0;

  await sql.begin(async (sql) => {
    for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
      const { count } = await sql`
        INSERT INTO erc20_tokens_usd_prices (
          chain_id,
          token_address,
          "timestamp",
          source,
          value
        )
        SELECT data.chain_id::int8,
               data.token_address::numeric,
               data.timestamp::timestamptz,
               data.source,
               data.usd_price::double precision
        FROM (values ${sql(
          rows.slice(offset, offset + INSERT_BATCH_SIZE),
        )}) as data (
          chain_id,
          token_address,
          timestamp,
          source,
          usd_price
        )
        JOIN erc20_tokens AS t
          ON t.chain_id = data.chain_id::int8
         AND t.token_address = data.token_address::numeric;
      `;
      insertedCount += count;
    }
  });

  return insertedCount;
}
