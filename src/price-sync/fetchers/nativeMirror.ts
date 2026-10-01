import { Clock, Effect, Stream } from "effect";
import type { Sql } from "postgres";
import { PriceSyncError, tryPriceSync } from "../errors";
import type { PriceSyncJob, PriceUpdate } from "./types";

const SOURCE = "em1";

type MirroredRow = {
  source: string;
  value: number;
  valid_until: Date;
};

interface NativeMirrorFetcherOptions {
  sql: Sql<{ bigint: bigint }>;
  // The chain whose native price is copied, and the chains that pay gas in the
  // same asset bridged 1:1 from it.
  fromChainId: bigint;
  toChainIds: bigint[];
  intervalMs: number;
}

// The best current native price on the source chain from anything but
// CoinGecko. The mirror exists to price these chains while CoinGecko is out,
// so copying `cg1`/`cgn` would fail along with the source it backs up. The
// source list is a constant, so it is written into the statement.
//
// Ordered by confidence, then source, so a tie at the top resolves the same
// way every cycle.
function readSourceChainNativePrice(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
): Effect.Effect<MirroredRow | undefined, PriceSyncError> {
  return tryPriceSync({
    source: SOURCE,
    operation: `read native price on chain ${chainId}`,
    try: () => sql<MirroredRow[]>`
      SELECT source::TEXT, value, valid_until
      FROM erc20_tokens_latest_price_by_source
      WHERE chain_id = ${chainId}
        AND token_address = 0
        AND source IN ('qp1', 'cl1', 'ss1')
        AND valid_until > NOW()
      ORDER BY confidence DESC, source
      LIMIT 1
    `,
  }).pipe(Effect.map((rows) => rows[0]));
}

/**
 * Copies one chain's native price onto chains whose native currency is the
 * same asset -- Ethereum's ETH onto L2s that pay gas in bridged ETH.
 *
 * Each row is stamped now rather than with the copied row's timestamp: the
 * price history is keyed by (chain, token, timestamp, source), so re-copying an
 * unchanged row under its old timestamp would collide and fail the batch. The
 * copied row's `valid_until` is kept, so a mirrored price never outlives the
 * one it was copied from.
 */
export function nativeMirrorPriceFetcher({
  sql,
  fromChainId,
  toChainIds,
  intervalMs,
}: NativeMirrorFetcherOptions): PriceSyncJob {
  const plan = Effect.fn("nativeMirror.plan")(function* () {
    const row = yield* readSourceChainNativePrice(sql, fromChainId);
    if (!row) {
      yield* Effect.logWarning(
        `No current non-CoinGecko native price on chain ${fromChainId} to mirror`,
      );
      return [];
    }

    const timestamp = new Date(yield* Clock.currentTimeMillis);
    // The query filters on the database clock and this compares against the
    // worker's, which can disagree by a few milliseconds; persisting a row
    // whose validity ends at or before its timestamp fails the whole batch.
    if (row.valid_until <= timestamp) return [];
    if (!Number.isFinite(row.value) || row.value <= 0) return [];

    yield* Effect.logInfo(
      `Mirroring chain ${fromChainId} native price ${row.value} from ${row.source} to chains ${toChainIds.join(", ")}`,
    );

    return toChainIds.map(
      (chainId): PriceUpdate => ({
        chainId,
        tokenAddress: "0x0",
        timestamp,
        usdPrice: row.value,
        validUntil: row.valid_until,
      }),
    );
  });

  return {
    chainIds: toChainIds,
    source: SOURCE,
    intervalMs,
    fetch: Stream.fromEffect(plan()).pipe(
      Stream.filter((updates) => updates.length > 0),
    ),
  };
}
