import type { PriceSyncJob } from "./fetchers/types";

export function priceSyncJobId(
  job: Pick<PriceSyncJob, "chainIds" | "source">,
): string {
  return `${job.chainIds.join("+")}:${job.source}`;
}

export function validatePriceSyncJobs(jobs: readonly PriceSyncJob[]): void {
  // A source may price many chains and a chain may have many sources, but two
  // jobs writing the same source on the same chain would race each other.
  const claimedChainSources = new Set<string>();

  for (const job of jobs) {
    const jobId = priceSyncJobId(job);

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
      !Number.isInteger(job.confidence) ||
      job.confidence < 0 ||
      job.confidence > 255
    ) {
      throw new Error(
        `Price sync job ${jobId} must use a confidence between 0 and 255`,
      );
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

    for (const chainId of job.chainIds) {
      const chainSource = `${chainId}:${job.source}`;
      if (claimedChainSources.has(chainSource)) {
        throw new Error(`Duplicate price sync job: ${chainSource}`);
      }
      claimedChainSources.add(chainSource);
    }
  }
}
