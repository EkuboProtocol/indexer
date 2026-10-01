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

test("no chain has both the ETH mirror and a Sushi job", () => {
  // Both write at confidence 1, and the latest-price recompute averages every
  // fresh row at the top confidence: on a shared chain the fallback would be a
  // blend labelled AVG instead of either source.
  const jobs = createPriceSyncJobs({
    sql: {} as Sql<{ bigint: bigint }>,
    defaultIntervalMs: 60_000,
    coingeckoIntervalMs: 300_000,
  });
  const chainsOf = (source: string) =>
    new Set(
      jobs.filter((job) => job.source === source).flatMap((job) => job.chainIds),
    );

  const mirrored = chainsOf("em1");
  const sushi = chainsOf("ss1");

  expect([...mirrored].sort()).toEqual([130n, 480n, 57073n]);
  expect([...mirrored].filter((chainId) => sushi.has(chainId))).toEqual([]);
});
