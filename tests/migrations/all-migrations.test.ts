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

  expect(result).toBe(64);
});
