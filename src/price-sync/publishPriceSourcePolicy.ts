import type { Sql } from "postgres";
import { priceSourceFreshnessMs, type PriceSyncJob } from "./fetchers/types";

type SourcePolicyRow = [
  source: string,
  confidence: number,
  freshnessTimeMs: number,
];

// Source policy is normalized into its own table because price history is the
// high-volume relation. Publishing it from the jobs that produce the prices
// keeps confidence and freshness in one place rather than drifting between the
// worker and the schema.
export async function publishPriceSourcePolicy(
  sql: Sql<{ bigint: bigint }>,
  jobs: readonly PriceSyncJob[],
): Promise<void> {
  const policyBySource = new Map<string, SourcePolicyRow>();

  for (const job of jobs) {
    const freshnessTimeMs = priceSourceFreshnessMs(job.intervalMs);
    const existing = policyBySource.get(job.source);

    // A source may be produced by several jobs on different cadences. Keep the
    // longest freshness so the slowest chain's observations are not expired
    // early by a faster one.
    if (!existing || freshnessTimeMs > existing[2]) {
      policyBySource.set(job.source, [
        job.source,
        job.confidence,
        freshnessTimeMs,
      ]);
    }
  }

  if (policyBySource.size === 0) return;

  const rows = [...policyBySource.values()];

  await sql`
    INSERT INTO erc20_token_price_sources (source, confidence, freshness_time)
    SELECT data.source::char(3),
           data.confidence::smallint,
           data.freshness_time_ms::double precision * INTERVAL '1 millisecond'
    FROM (values ${sql(rows)})
             AS data (source, confidence, freshness_time_ms)
    ON CONFLICT (source) DO UPDATE
      SET confidence     = excluded.confidence,
          freshness_time = excluded.freshness_time;
  `;
}
