import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../helpers/db";

test("close drains pending cursor writes and preserves the migrated database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pglite-close-"));
  let client = new PGlite(directory);
  try {
    await runMigrations(client);
    const write = client.query(`
      INSERT INTO indexer_cursor (chain_id, order_key, last_updated)
      VALUES (1, 9007199254740993, NOW())
    `);
    const transaction = client.transaction(async (tx) => {
      await tx.query(
        `UPDATE indexer_cursor SET order_key = order_key + 1 WHERE chain_id = 1`,
      );
    });
    // No await between issuing the operations and closing the database.
    await Promise.all([write, transaction, client.close()]);

    client = new PGlite(directory);
    const { rows } = await client.query<{ order_key: string }>(
      "SELECT order_key::text FROM indexer_cursor WHERE chain_id = 1",
    );
    expect(rows).toEqual([{ order_key: "9007199254740994" }]);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
