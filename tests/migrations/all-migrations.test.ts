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
    `SELECT count(1) as result FROM information_schema.tables WHERE table_schema = 'public'`
  );

  // 00129 adds two extension tables and the latest-event view; 00130 adds
  // four continuous auction tables; 00131 adds five tables and four views.
  expect(result).toBe(101);
});
