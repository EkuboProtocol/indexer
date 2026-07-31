import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../helpers/db.js";

const BASE_MIGRATIONS = ["00001_chain_tables", "00002_core_tables"] as const;

test("pool keys are indexed by chain and token pair", async () => {
  const client = new PGlite("memory://pool-keys-pair-index");
  try {
    await runMigrations(client, { files: [...BASE_MIGRATIONS] });
    await runMigrations(client, { files: ["00110_pool_keys_pair_index"] });

    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'pool_keys_chain_id_token0_token1_idx'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain(
      "USING btree (chain_id, token0, token1)",
    );
  } finally {
    await client.close();
  }
});
