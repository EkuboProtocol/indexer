import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

test("token USD price history uses a covering range index", async () => {
  const client = await createClient();
  try {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'erc20_tokens_usd_prices_history_covering_idx'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain(
      'USING btree (chain_id, token_address, "timestamp" DESC) INCLUDE (value, source)',
    );

    const { rows: supersededIndexes } = await client.query(
      `SELECT 1
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'erc20_tokens_usd_prices_latest_idx'`,
    );

    expect(supersededIndexes).toHaveLength(0);
  } finally {
    await client.close();
  }
});
