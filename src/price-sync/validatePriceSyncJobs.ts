import type { PriceSyncJob } from "./fetchers/types";

export function priceSyncJobId(
  job: Pick<PriceSyncJob, "chainIds" | "source">,
): string {
  return `${job.chainIds.join("+")}:${job.source}`;
}

// Checks a single job in isolation. Split from validatePriceSyncJobs so that
// function is only about the cross-job invariant -- no two jobs writing the
// same source on the same chain -- and this one is only about field shape.
function assertJobIsWellFormed(job: PriceSyncJob, jobId: string): void {
  if (job.source.length !== 3) {
    throw new Error(
      `Price sync job ${jobId} must use a three-character source identifier`,
    );
  }
  if (job.chainIds.length === 0) {
    throw new Error(`Price sync job ${jobId} must price at least one chain`);
  }
  if (new Set(job.chainIds).size !== job.chainIds.length) {
    throw new Error(`Price sync job ${jobId} repeats a chain ID`);
  }
  if (job.chainIds.some((chainId) => chainId <= 0n)) {
    throw new Error(`Price sync job ${jobId} must use positive chain IDs`);
  }
  if (
    !Number.isFinite(job.intervalMs) ||
    !Number.isInteger(job.intervalMs) ||
    job.intervalMs < 0
  ) {
    throw new Error(
      `Price sync job ${jobId} must use a non-negative integer interval`,
    );
  }
}

export function validatePriceSyncJobs(jobs: readonly PriceSyncJob[]): void {
  // A source may price many chains and a chain may have many sources, but two
  // jobs writing the same source on the same chain would race each other.
  const claimedChainSources = new Set<string>();

  for (const job of jobs) {
    const jobId = priceSyncJobId(job);
    assertJobIsWellFormed(job, jobId);

    for (const chainId of job.chainIds) {
      const chainSource = `${chainId}:${job.source}`;
      if (claimedChainSources.has(chainSource)) {
        throw new Error(`Duplicate price sync job: ${chainSource}`);
      }
      claimedChainSources.add(chainSource);
    }
  }
}
