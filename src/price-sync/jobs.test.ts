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

test("Chainlink jobs are only created for configured chains", () => {
  const withoutChainlink = createPriceSyncJobs({
    sql: {} as Sql<{ bigint: bigint }>,
    defaultIntervalMs: 60_000,
    coingeckoIntervalMs: 300_000,
  });
  expect(withoutChainlink.some((job) => job.source === "cl1")).toBe(false);

  const withChainlink = createPriceSyncJobs({
    sql: {} as Sql<{ bigint: bigint }>,
    defaultIntervalMs: 60_000,
    coingeckoIntervalMs: 300_000,
    chainlinkIntervalMs: 60_000,
    chainlinkConfig: {
      "1": {
        rpcUrls: ["https://eth-mainnet.example"],
        feeds: [],
        catalogUrl: "https://catalog.example/feeds-mainnet.json",
      },
    },
    chainlinkCatalogRefreshIntervalMs: 3_600_000,
  });

  expect(() => validatePriceSyncJobs(withChainlink)).not.toThrow();
  expect(
    withChainlink.filter((job) => job.source === "cl1").map(priceSyncJobId),
  ).toEqual(["1:cl1"]);
});

test("every job declares a confidence the sources table can store", () => {
  for (const job of createPriceSyncJobs({
    sql: {} as Sql<{ bigint: bigint }>,
    defaultIntervalMs: 60_000,
    coingeckoIntervalMs: 300_000,
  })) {
    expect(Number.isInteger(job.confidence)).toBe(true);
    expect(job.confidence).toBeGreaterThanOrEqual(0);
    expect(job.confidence).toBeLessThanOrEqual(255);
  }
});
