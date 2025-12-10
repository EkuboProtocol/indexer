import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "./helpers/db.js";

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: ["00067_nft_token_salt_function"] });
});

afterAll(async () => {
  await client.close();
});

test("nft_token_salt returns identity when transform is null", async () => {
  const tokenId = "12345678901234567890";
  const {
    rows: [{ salt }],
  } = await client.query<{ salt: string }>(
    `SELECT nft_token_salt(NULL, $1::numeric)::text AS salt`,
    [tokenId]
  );

  expect(salt).toBe(tokenId);
});

test("nft_token_salt applies bit_mod using bit precision", async () => {
  const tokenId = (2n ** 200n + 1234n).toString();
  const expected = (BigInt(tokenId) % 2n ** 192n).toString();

  const {
    rows: [{ salt }],
  } = await client.query<{ salt: string }>(
    `SELECT nft_token_salt($1::jsonb, $2::numeric)::text AS salt`,
    [JSON.stringify({ bit_mod: 192 }), tokenId]
  );

  expect(salt).toBe(expected);
});

test("nft_token_salt accepts string bit_mod", async () => {
  const tokenId = (2n ** 70n + 42n).toString();
  const expected = (BigInt(tokenId) % 2n ** 64n).toString();

  const {
    rows: [{ salt }],
  } = await client.query<{ salt: string }>(
    `SELECT nft_token_salt($1::jsonb, $2::numeric)::text AS salt`,
    [JSON.stringify({ bit_mod: "64" }), tokenId]
  );

  expect(salt).toBe(expected);
});
