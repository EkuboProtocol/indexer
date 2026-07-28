import { expect, test } from "bun:test";
import type { Sql } from "postgres";
import { createPriceSyncJobs } from "./jobs";
import { priceSyncJobId, validatePriceSyncJobs } from "./validatePriceSyncJobs";

test("configured price sync jobs have unique semantic IDs", () => {
  const jobs = createPriceSyncJobs({
    sql: {} as Sql<{ bigint: bigint }>,
    defaultIntervalMs: 60_000,
    coingeckoIntervalMs: 300_000,
  });

  expect(() => validatePriceSyncJobs(jobs)).not.toThrow();
  expect(new Set(jobs.map(priceSyncJobId)).size).toBe(jobs.length);
});
