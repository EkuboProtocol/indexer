import { SQL } from "bun";
import type { CursorRow } from "./headLagRules";

/**
 * One read-only pass over `indexer_cursor` with a 15 s statement timeout. Lag
 * is computed against the database clock so the monitor host's clock does not
 * matter. Shared by `monitorHeadLag.ts` and `productionMonitor.ts`.
 */
export async function readCursors(
  url: string | undefined,
): Promise<CursorRow[]> {
  if (!url) throw new Error("PG_CONNECTION_STRING is required");
  const sql = new SQL(url, { max: 1, connectionTimeout: 10, idleTimeout: 5 });
  try {
    const rows = await sql.begin("read only", async (tx) => {
      await tx`SET LOCAL statement_timeout = '15s'`;
      return tx`
        SELECT chain_id::text                                        AS "chainId",
               head_block_number::text                               AS "headBlockNumber",
               EXTRACT(EPOCH FROM now() - head_block_time)::float8   AS "lagSeconds",
               EXTRACT(EPOCH FROM now() - last_updated)::float8      AS "updatedSecondsAgo"
        FROM indexer_cursor`;
    });
    return rows as CursorRow[];
  } finally {
    await sql.close({ timeout: 5 });
  }
}
