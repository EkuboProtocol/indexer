import { expect, test } from "bun:test";
import type { PriceSyncJob } from "./fetchers/types";
import { priceSyncJobId, validatePriceSyncJobs } from "./validatePriceSyncJobs";

function job({
  chainIds,
  source,
  intervalMs = 1_000,
}: {
  chainIds: readonly bigint[];
  source: string;
  intervalMs?: number;
}): PriceSyncJob {
  return {
    chainIds,
    source,
    intervalMs,
    fetch: async function* () {},
  };
}

test("priceSyncJobId derives the semantic chain and source identity", () => {
  expect(priceSyncJobId(job({ chainIds: [4663n], source: "cg1" }))).toBe(
    "4663:cg1",
  );
  expect(priceSyncJobId(job({ chainIds: [1n, 8453n], source: "cgn" }))).toBe(
    "1+8453:cgn",
  );
});

test("validatePriceSyncJobs rejects duplicate chain and source jobs", () => {
  expect(() =>
    validatePriceSyncJobs([
      job({ chainIds: [4663n], source: "cg1" }),
      job({ chainIds: [4663n], source: "cg1", intervalMs: 5_000 }),
    ]),
  ).toThrow("Duplicate price sync job: 4663:cg1");
});

test("validatePriceSyncJobs rejects a chain claimed by a multi-chain job", () => {
  expect(() =>
    validatePriceSyncJobs([
      job({ chainIds: [1n, 8453n], source: "cgn" }),
      job({ chainIds: [8453n], source: "cgn" }),
    ]),
  ).toThrow("Duplicate price sync job: 8453:cgn");
});

test("validatePriceSyncJobs rejects a job that repeats a chain", () => {
  expect(() =>
    validatePriceSyncJobs([job({ chainIds: [1n, 1n], source: "cgn" })]),
  ).toThrow("repeats a chain ID");
});

test("validatePriceSyncJobs rejects a job with no chains", () => {
  expect(() =>
    validatePriceSyncJobs([job({ chainIds: [], source: "cgn" })]),
  ).toThrow("must price at least one chain");
});

test("validatePriceSyncJobs accepts the same source on different chains", () => {
  expect(() =>
    validatePriceSyncJobs([
      job({ chainIds: [1n], source: "cg1" }),
      job({ chainIds: [4663n], source: "cg1" }),
      job({ chainIds: [4663n], source: "ss1" }),
      job({ chainIds: [1n, 4663n], source: "cgn" }),
    ]),
  ).not.toThrow();
});
