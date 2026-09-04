import type { Effect } from "effect";
import type { Sql } from "postgres";
import { type PriceSyncError, tryPriceSync } from "./errors";
import type { PriceUpdate } from "./fetchers/types";

const INSERT_BATCH_SIZE = 1_000;

type PriceRow = [
  chainId: string,
  tokenAddress: string,
  timestamp: string,
  source: string,
  usdPrice: number,
  validUntil: string,
];

function toPriceRow(
  source: string,
  update: PriceUpdate,
  defaultValidityMs: number,
): PriceRow {
  if (!Number.isFinite(update.usdPrice) || update.usdPrice <= 0) {
    throw new Error(`Invalid USD price: ${update.usdPrice}`);
  }
  if (Number.isNaN(update.timestamp.getTime())) {
    throw new Error("Invalid price update timestamp");
  }

  // Validity is anchored at the observation timestamp so a source reporting an
  // already-old measurement does not have its age laundered away.
  const validUntil =
    update.validUntil ??
    new Date(update.timestamp.getTime() + defaultValidityMs);
  if (Number.isNaN(validUntil.getTime()) || validUntil <= update.timestamp) {
    throw new Error("Invalid price update validity horizon");
  }

  return [
    update.chainId.toString(),
    BigInt(update.tokenAddress).toString(),
    update.timestamp.toISOString(),
    source,
    update.usdPrice,
    validUntil.toISOString(),
  ];
}

/**
 * Writes one batch, inside one transaction.
 *
 * The transaction stays whole inside a single `tryPromise`: `sql.begin` owns
 * the connection and wants a promise-returning callback, so lifting the batch
 * inserts into Effect would mean running a fiber per statement through a
 * bridge and losing the scope the driver is already managing. The Effect
 * boundary belongs here, at the edge of the transaction.
 */
export function persistPriceUpdates(
  sql: Sql<{ bigint: bigint }>,
  source: string,
  updates: readonly PriceUpdate[],
  defaultValidityMs: number,
): Effect.Effect<number, PriceSyncError> {
  return tryPriceSync({
    source,
    operation: `persist ${updates.length} price updates`,
    try: () => writeBatches(sql, source, updates, defaultValidityMs),
  });
}

async function writeBatches(
  sql: Sql<{ bigint: bigint }>,
  source: string,
  updates: readonly PriceUpdate[],
  defaultValidityMs: number,
): Promise<number> {
  if (updates.length === 0) return 0;

  const rows = updates.map((update) =>
    toPriceRow(source, update, defaultValidityMs),
  );
  let insertedCount = 0;

  await sql.begin(async (sql) => {
    for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
      const { count } = await sql`
        INSERT INTO erc20_tokens_usd_prices (
          chain_id,
          token_address,
          "timestamp",
          source,
          value,
          valid_until
        )
        SELECT data.chain_id::int8,
               data.token_address::numeric,
               data.timestamp::timestamptz,
               data.source,
               data.usd_price::double precision,
               data.valid_until::timestamptz
        FROM (values ${sql(
          rows.slice(offset, offset + INSERT_BATCH_SIZE),
        )}) as data (
          chain_id,
          token_address,
          timestamp,
          source,
          usd_price,
          valid_until
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
