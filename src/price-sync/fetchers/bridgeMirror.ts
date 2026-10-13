import { Clock, Effect, Stream } from "effect";
import type { Sql } from "postgres";
import { PriceSyncError, tryPriceSync } from "../errors";
import type { PriceSyncJob, PriceUpdate } from "./types";
import { toHexTokenAddress } from "./utils";

const SOURCE = "bm1";

type MirroredRow = {
  chain_id: bigint;
  token_address: string;
  value: number;
  valid_until: Date;
};

interface BridgeMirrorFetcherOptions {
  sql: Sql<{ bigint: bigint }>;
  // The chains whose tokens may receive a mirrored price.
  chainIds: bigint[];
  intervalMs: number;
}

// For every listed token on the given chains that no other source currently
// prices, the best current price of a token it is bridged to or from.
//
// A relationship is read in both directions: token lists record an L2 token's
// canonical L1 counterpart on the L2 token, and StarkGate records the reverse.
// Mirrored rows are never copied again, so a price only travels one hop from a
// direct observation. Ordered by confidence, then counterpart chain and source,
// so a token with several priced counterparts resolves the same way every cycle.
function readMirroredPrices(
  sql: Sql<{ bigint: bigint }>,
  chainIds: readonly bigint[],
): Effect.Effect<MirroredRow[], PriceSyncError> {
  return tryPriceSync({
    source: SOURCE,
    operation: `read bridged counterpart prices for chains ${chainIds.join(", ")}`,
    try: () => sql<MirroredRow[]>`
      WITH pairs AS (
        SELECT dest_chain_id AS chain_id,
               dest_token_address AS token_address,
               source_chain_id AS from_chain_id,
               source_token_address AS from_token_address
        FROM erc20_tokens_bridge_relationships
        UNION
        SELECT source_chain_id,
               source_token_address,
               dest_chain_id,
               dest_token_address
        FROM erc20_tokens_bridge_relationships
      )
      SELECT DISTINCT ON (p.chain_id, p.token_address)
             p.chain_id,
             p.token_address::TEXT,
             lp.value,
             lp.valid_until
      FROM pairs p
      JOIN erc20_tokens t
        ON t.chain_id = p.chain_id
       AND t.token_address = p.token_address
      JOIN erc20_tokens_latest_price_by_source lp
        ON lp.chain_id = p.from_chain_id
       AND lp.token_address = p.from_token_address
      WHERE p.chain_id = ANY(${chainIds.map(String)}::INT8[])
        AND p.token_address > 0
        AND t.visibility_priority >= 0
        AND lp.source <> ${SOURCE}
        AND lp.valid_until > NOW()
        AND lp.value > 0
        AND NOT EXISTS (
          SELECT 1
          FROM erc20_tokens_latest_price_by_source own
          WHERE own.chain_id = p.chain_id
            AND own.token_address = p.token_address
            AND own.source <> ${SOURCE}
            AND own.valid_until > NOW()
        )
      ORDER BY p.chain_id, p.token_address,
               lp.confidence DESC, p.from_chain_id, lp.source
    `,
  });
}

/**
 * Prices a token no source prices directly from the token it is bridged to or
 * from on another chain -- an L2's canonically bridged AAVE from AAVE on
 * Ethereum, for instance.
 *
 * Only tokens without a current price of their own are written, and the
 * source ranks below every direct observation, so a token that gains a price
 * of its own on its chain stops being mirrored at once.
 *
 * Like the native mirror, each row is stamped now and keeps the copied row's
 * `valid_until`, so a mirrored price never outlives the one it was copied from.
 */
export function bridgeMirrorPriceFetcher({
  sql,
  chainIds,
  intervalMs,
}: BridgeMirrorFetcherOptions): PriceSyncJob {
  const plan = Effect.fn("bridgeMirror.plan")(function* () {
    const rows = yield* readMirroredPrices(sql, chainIds);
    const timestamp = new Date(yield* Clock.currentTimeMillis);

    const updates = new Map<bigint, PriceUpdate[]>();
    for (const row of rows) {
      // The query filters on the database clock and this on the worker's;
      // a validity ending at or before the timestamp fails the whole batch.
      if (row.valid_until <= timestamp) continue;
      if (!Number.isFinite(row.value) || row.value <= 0) continue;

      const chainId = BigInt(row.chain_id);
      const batch = updates.get(chainId) ?? [];
      batch.push({
        chainId,
        tokenAddress: toHexTokenAddress(row.token_address),
        timestamp,
        usdPrice: row.value,
        validUntil: row.valid_until,
      });
      updates.set(chainId, batch);
    }

    yield* Effect.logInfo(
      `Mirroring ${rows.length} bridged token prices to chains ${[
        ...updates.keys(),
      ].join(", ")}`,
    );

    return [...updates.values()];
  });

  return {
    chainIds,
    source: SOURCE,
    intervalMs,
    fetch: Stream.unwrap(Effect.map(plan(), Stream.fromIterable)),
  };
}
