import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

const MIGRATIONS = [
  "00001_chain_tables",
  "00093_indexer_cursor_fork_counter",
] as const;

test("blocks insert fills fork_counter from indexer_cursor when null", async () => {
  const client = await createClient({ files: [...MIGRATIONS] });

  await client.query(
    `INSERT INTO indexer_cursor (chain_id, order_key, unique_key, last_updated, fork_counter)
     VALUES ($1, $2, $3, $4, $5)`,
    [1, 0, null, new Date(), 7]
  );

  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events, fork_counter)
     VALUES ($1, $2, $3, $4, $5, NULL)`,
    [1, 1, "1001", new Date("2024-01-01T00:00:00Z"), 0]
  );

  const {
    rows: [{ fork_counter }],
  } = await client.query<{ fork_counter: string }>(
    `SELECT fork_counter::text AS fork_counter
     FROM blocks
     WHERE chain_id = $1 AND block_number = $2`,
    [1, 1]
  );

  expect(fork_counter).toBe("7");
});

test("blocks delete bumps fork_counter once per statement per chain", async () => {
  const client = await createClient({ files: [...MIGRATIONS] });

  await client.query(
    `INSERT INTO indexer_cursor (chain_id, order_key, unique_key, last_updated, fork_counter)
     VALUES ($1, 0, NULL, $2, $3), ($4, 0, NULL, $2, $5)`,
    [1, new Date(), 1, 2, 10]
  );

  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES
       ($1, $2, $3, $4, $5),
       ($1, $6, $7, $4, $5),
       ($8, $6, $9, $4, $5),
       ($8, $10, $11, $4, $5)`,
    [1, 1, "1001", new Date("2024-01-01T00:00:00Z"), 0, 2, "1002", 2, "2002", 3, "2003"]
  );

  await client.query(`DELETE FROM blocks WHERE block_number >= 2`);

  const { rows } = await client.query<{ chain_id: number; fork_counter: string }>(
    `SELECT chain_id, fork_counter::text AS fork_counter
     FROM indexer_cursor
     WHERE chain_id IN (1, 2)
     ORDER BY chain_id`
  );

  expect(rows).toEqual([
    { chain_id: 1, fork_counter: "2" },
    { chain_id: 2, fork_counter: "11" },
  ]);

  await client.query(`DELETE FROM blocks WHERE block_number > 100`);

  const { rows: unchanged } = await client.query<{
    chain_id: number;
    fork_counter: string;
  }>(
    `SELECT chain_id, fork_counter::text AS fork_counter
     FROM indexer_cursor
     WHERE chain_id IN (1, 2)
     ORDER BY chain_id`
  );

  expect(unchanged).toEqual(rows);
});
