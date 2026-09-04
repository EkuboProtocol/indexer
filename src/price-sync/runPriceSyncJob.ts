import { Effect, Stream } from "effect";
import { PriceSyncError } from "./errors";
import type { PriceSyncJob, PriceUpdate } from "./fetchers/types";
import { priceSyncJobId } from "./validatePriceSyncJobs";

export interface PriceSyncResult {
  batchCount: number;
  updateCount: number;
  insertedCount: number;
}

export interface PriceUpdateWriter {
  (
    source: string,
    updates: readonly PriceUpdate[],
  ): Effect.Effect<number, PriceSyncError>;
}

/**
 * Drains one job's stream, writing each batch as it arrives.
 *
 * `runForEach` pulls the next batch only after the current one is written, so a
 * paginating source still persists page N before requesting page N+1 -- the
 * property the async generator gave for free, kept deliberately here.
 */
export const runPriceSyncJob = Effect.fn("runPriceSyncJob")(function* (
  job: PriceSyncJob,
  writeUpdates: PriceUpdateWriter,
) {
  const allowedChainIds = new Set(job.chainIds);
  const result: PriceSyncResult = {
    batchCount: 0,
    updateCount: 0,
    insertedCount: 0,
  };

  yield* Stream.runForEach(
    job.fetch,
    Effect.fn("runPriceSyncJob.writeBatch")(function* (
      updates: readonly PriceUpdate[],
    ) {
      if (updates.length === 0) return;

      for (const update of updates) {
        if (!allowedChainIds.has(update.chainId)) {
          return yield* Effect.fail(
            new PriceSyncError({
              source: job.source,
              operation: "validate batch",
              cause: new Error(
                `Price sync job ${priceSyncJobId(
                  job,
                )} yielded an update for chain ${update.chainId}`,
              ),
            }),
          );
        }
      }

      result.batchCount += 1;
      result.updateCount += updates.length;
      result.insertedCount += yield* writeUpdates(job.source, updates);
    }),
  );

  return result;
});
