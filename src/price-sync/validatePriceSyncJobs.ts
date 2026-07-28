import type { PriceSyncJob } from "./fetchers/types";

export function priceSyncJobId(
  job: Pick<PriceSyncJob, "chainId" | "source">,
): string {
  return `${job.chainId}:${job.source}`;
}

export function validatePriceSyncJobs(jobs: readonly PriceSyncJob[]): void {
  const jobIds = new Set<string>();

  for (const job of jobs) {
    const jobId = priceSyncJobId(job);

    if (job.source.length !== 3) {
      throw new Error(
        `Price sync job ${jobId} must use a three-character source identifier`,
      );
    }
    if (job.chainId <= 0n) {
      throw new Error(`Price sync job ${jobId} must use a positive chain ID`);
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
    if (jobIds.has(jobId)) {
      throw new Error(`Duplicate price sync job: ${jobId}`);
    }

    jobIds.add(jobId);
  }
}
