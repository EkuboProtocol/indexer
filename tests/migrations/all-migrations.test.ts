import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

let client: PGlite;

beforeAll(async () => {
  client = await createClient();
});

afterAll(async () => {
  await client.close();
});

test("all migrations apply successfully", async () => {
  const {
    rows: [{ result }],
  } = await client.query<{ result: number }>(
    `SELECT count(1) as result FROM information_schema.tables WHERE table_schema = 'public'`,
  );

  expect(result).toBe(84);
});

test("ve33 active voter lookup uses a partial covering index", async () => {
  const { rows } = await client.query<{ indexdef: string }>(
    `SELECT indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 've33_pool_vote_states_active_by_extension'`,
  );

  expect(rows).toHaveLength(1);
  const [{ indexdef }] = rows;
  expect(indexdef).toContain("(chain_id, emitter)");
  expect(indexdef).toContain("INCLUDE (owner, event_id, weight)");
  expect(indexdef).toContain("WHERE (weight > (0)::numeric)");
});
