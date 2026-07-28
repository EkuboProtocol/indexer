import type { PriceSyncJob, PriceUpdate } from "./fetchers/types";
import { priceSyncJobId } from "./validatePriceSyncJobs";

export interface PriceSyncResult {
  batchCount: number;
  updateCount: number;
  insertedCount: number;
}

export interface PriceUpdateWriter {
  (source: string, updates: readonly PriceUpdate[]): Promise<number>;
}

export async function runPriceSyncJob(
  job: PriceSyncJob,
  writeUpdates: PriceUpdateWriter,
): Promise<PriceSyncResult> {
  let batchCount = 0;
  let updateCount = 0;
  let insertedCount = 0;

  for await (const updates of job.fetch()) {
    if (updates.length === 0) continue;

    for (const update of updates) {
      if (update.chainId !== job.chainId) {
        throw new Error(
          `Price sync job ${priceSyncJobId(
            job,
          )} yielded an update for chain ${update.chainId}`,
        );
      }
    }

    batchCount += 1;
    updateCount += updates.length;
    insertedCount += await writeUpdates(job.source, updates);
  }

  return { batchCount, updateCount, insertedCount };
}
