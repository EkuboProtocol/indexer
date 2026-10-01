import type { Effect } from "effect";
import type { Sql } from "postgres";
import { type PriceSyncError, tryPriceSync } from "./errors";
import type { PriceUpdate } from "./fetchers/types";

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
 * Writes one batch in a single statement.
 *
 * It has to be one statement, not one transaction of several. The insert
 * trigger on erc20_tokens_usd_prices locks each affected token's row in
 * erc20_tokens_latest_price in (chain_id, token_address) order, and those locks
 * are held until commit. Every concurrent job on the same chain takes them in
 * that order, which is what keeps the jobs from deadlocking. Splitting a batch
 * into several INSERTs would sort each chunk on its own, while the chunks run in
 * the fetcher's order. A Sushi batch of thousands of tokens would then lock in
 * an order no other job uses, and the smaller Chainlink and CoinGecko persists
 * on that chain deadlocked against it (EKU-562). Passing each column as one
 * array parameter keeps a batch of any size to six bind parameters, so nothing
 * forces the batch to be split.
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
    try: () => writeBatch(sql, source, updates, defaultValidityMs),
  });
}

async function writeBatch(
  sql: Sql<{ bigint: bigint }>,
  source: string,
  updates: readonly PriceUpdate[],
  defaultValidityMs: number,
): Promise<number> {
  if (updates.length === 0) return 0;

  const rows = updates.map((update) =>
    toPriceRow(source, update, defaultValidityMs),
  );
  const column = <I extends keyof PriceRow>(index: I) =>
    rows.map((row) => row[index]);

  const { count } = await sql`
    INSERT INTO erc20_tokens_usd_prices (
      chain_id,
      token_address,
      "timestamp",
      source,
      value,
      valid_until
    )
    SELECT data.chain_id,
           data.token_address,
           data.timestamp,
           data.source,
           data.usd_price,
           data.valid_until
    FROM unnest(
      ${column(0)}::int8[],
      ${column(1)}::numeric[],
      ${column(2)}::timestamptz[],
      ${column(3)}::text[],
      ${column(4)}::double precision[],
      ${column(5)}::timestamptz[]
    ) AS data (
      chain_id,
      token_address,
      timestamp,
      source,
      usd_price,
      valid_until
    )
    JOIN erc20_tokens AS t
      ON t.chain_id = data.chain_id
     AND t.token_address = data.token_address;
  `;

  return count;
}
