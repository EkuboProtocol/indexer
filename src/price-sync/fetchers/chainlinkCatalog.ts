import { Clock, Effect, Ref } from "effect";
import { PriceSyncError, tryPriceSync } from "../errors";
import { fetchChainlinkFeedCatalog } from "./chainlinkFeeds";

const SOURCE = "cl1";

export interface ChainlinkCatalogCache {
  (
    catalogUrl: string,
    refreshIntervalMs: number,
  ): Effect.Effect<unknown, PriceSyncError>;
}

interface CachedCatalog {
  catalog: unknown;
  lastAttemptAt: number;
}

/**
 * Catalogs are shared between chains only by URL, so this caches on that. The
 * last successful response stays usable during a catalog outage.
 *
 * One cache is built for the whole worker and handed to every Chainlink job,
 * which is what the module-level `Map` did implicitly -- except that this one
 * is reachable from a test without reloading the module.
 */
export function makeChainlinkCatalogCache(): ChainlinkCatalogCache {
  const entries = Ref.makeUnsafe(new Map<string, CachedCatalog>());

  const refresh = Effect.fn("chainlink.refreshCatalog")(function* (
    catalogUrl: string,
    cached: CachedCatalog | undefined,
    now: number,
  ) {
    const fetched = yield* tryPriceSync({
      source: SOURCE,
      operation: `fetch feed catalog ${catalogUrl}`,
      try: () => fetchChainlinkFeedCatalog(catalogUrl),
    }).pipe(
      Effect.catch((error) =>
        cached
          ? Effect.logWarning(
              `Failed to refresh Chainlink feed catalog ${catalogUrl}; using cached catalog: ${error.message}`,
            ).pipe(Effect.as(null))
          : Effect.fail(error),
      ),
    );

    const entry: CachedCatalog =
      fetched === null
        ? { catalog: cached!.catalog, lastAttemptAt: now }
        : { catalog: fetched, lastAttemptAt: now };

    yield* Ref.update(entries, (map) => new Map(map).set(catalogUrl, entry));
    return entry.catalog;
  });

  return Effect.fn("chainlink.getCatalog")(function* (
    catalogUrl: string,
    refreshIntervalMs: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = (yield* Ref.get(entries)).get(catalogUrl);

    if (cached && now - cached.lastAttemptAt < refreshIntervalMs) {
      return cached.catalog;
    }

    return yield* refresh(catalogUrl, cached, now);
  });
}
