import { expect, test } from "bun:test";
import type { PriceSyncJob } from "./fetchers/types";
import { priceSyncJobId, validatePriceSyncJobs } from "./validatePriceSyncJobs";

function job({
  chainId,
  source,
  intervalMs = 1_000,
}: {
  chainId: bigint;
  source: string;
  intervalMs?: number;
}): PriceSyncJob {
  return {
    chainId,
    source,
    intervalMs,
    fetch: async function* () {},
  };
}

test("priceSyncJobId derives the semantic chain and source identity", () => {
  expect(priceSyncJobId(job({ chainId: 4663n, source: "cg1" }))).toBe(
    "4663:cg1",
  );
});

test("validatePriceSyncJobs rejects duplicate chain and source jobs", () => {
  expect(() =>
    validatePriceSyncJobs([
      job({ chainId: 4663n, source: "cg1" }),
      job({ chainId: 4663n, source: "cg1", intervalMs: 5_000 }),
    ]),
  ).toThrow("Duplicate price sync job: 4663:cg1");
});

test("validatePriceSyncJobs accepts the same source on different chains", () => {
  expect(() =>
    validatePriceSyncJobs([
      job({ chainId: 1n, source: "cg1" }),
      job({ chainId: 4663n, source: "cg1" }),
      job({ chainId: 4663n, source: "ss1" }),
    ]),
  ).not.toThrow();
});
