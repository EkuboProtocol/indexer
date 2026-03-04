import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "../helpers/db.js";

const usdcEthereum = BigInt("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const usdcBase = BigInt("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
const usdcBaseSepolia = BigInt("0x036cbd53842c5426634e7929541ec2318f3dcf7e");

const eurcEthereum = BigInt("0x1abaea1f7c830bd89acc67ec4af516284b1bc33c");
const eurcBase = BigInt("0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42");

test("circle stablecoin migration inserts relationships without requiring token rows", async () => {
  const client = await createClient({
    files: [
      "00018_tokens",
      "00079_erc20_tokens_bridge_pk",
      "00080_drop_erc20_bridge_source_fk",
    ],
  });

  try {
    const migrationSql = await readFile(
      path.resolve(
        process.cwd(),
        "migrations/00097_circle_stablecoin_bridge_relationships/index.sql"
      ),
      "utf8"
    );

    await client.exec(migrationSql);

    const {
      rows: [{ count }],
    } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM erc20_tokens_bridge_relationships`
    );

    expect(count).toBe("880");

    const { rows: usdcMainnetPair } = await client.query(
      `SELECT 1
       FROM erc20_tokens_bridge_relationships
       WHERE source_chain_id = 1
         AND source_token_address = $1
         AND dest_chain_id = 8453
         AND dest_token_address = $2`,
      [usdcEthereum, usdcBase]
    );
    expect(usdcMainnetPair.length).toBe(1);

    const { rows: noMainnetToTestnet } = await client.query(
      `SELECT 1
       FROM erc20_tokens_bridge_relationships
       WHERE source_chain_id = 1
         AND source_token_address = $1
         AND dest_chain_id = 84532
         AND dest_token_address = $2`,
      [usdcEthereum, usdcBaseSepolia]
    );
    expect(noMainnetToTestnet.length).toBe(0);

    const { rows: eurcMainnetPair } = await client.query(
      `SELECT 1
       FROM erc20_tokens_bridge_relationships
       WHERE source_chain_id = 1
         AND source_token_address = $1
         AND dest_chain_id = 8453
         AND dest_token_address = $2`,
      [eurcEthereum, eurcBase]
    );
    expect(eurcMainnetPair.length).toBe(1);

    await client.exec(migrationSql);

    const {
      rows: [{ count: countAfterSecondRun }],
    } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM erc20_tokens_bridge_relationships`
    );

    expect(countAfterSecondRun).toBe("880");
  } finally {
    await client.close();
  }
});
