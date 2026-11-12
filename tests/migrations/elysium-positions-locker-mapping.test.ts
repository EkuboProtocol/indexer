import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const POSITIONS = "0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326";

let client: PGlite;

beforeAll(async () => {
  client = await createClient();
});

afterAll(async () => {
  await client.close();
});

test("Elysium Positions tokens derive their salt like every other chain", async () => {
  const { rows } = await client.query<{
    chain_id: string;
    locker: string;
    token_id_transform: { bit_mod: number };
  }>(
    `SELECT chain_id::TEXT AS chain_id,
            locker::TEXT AS locker,
            token_id_transform
     FROM nft_locker_mappings
     WHERE nft_address = $1::NUMERIC
       AND chain_id IN (8453, 99901)
     ORDER BY chain_id`,
    [BigInt(POSITIONS).toString()],
  );

  expect(rows).toHaveLength(2);
  const [base, elysium] = rows;
  expect(elysium.chain_id).toBe("99901");
  expect(elysium.locker).toBe(base.locker);
  expect(elysium.token_id_transform).toEqual(base.token_id_transform);
  expect(elysium.token_id_transform).toEqual({ bit_mod: 192 });
});

test("an Elysium position token id maps to its low 192 bits", async () => {
  const tokenId = (1n << 200n) | 12345n;
  const {
    rows: [{ salt }],
  } = await client.query<{ salt: string }>(
    `SELECT nft_token_salt(token_id_transform, $1::NUMERIC)::TEXT AS salt
     FROM nft_locker_mappings
     WHERE chain_id = 99901 AND nft_address = $2::NUMERIC`,
    [tokenId.toString(), BigInt(POSITIONS).toString()],
  );

  expect(salt).toBe("12345");
});
