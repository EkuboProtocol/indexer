import { expect, test } from "bun:test";
import { createClient, runMigrations } from "../helpers/db.js";

const baseMigrations = [
  "00018_tokens",
  "00079_erc20_tokens_bridge_pk",
  "00080_drop_erc20_bridge_source_fk",
];

test("adds nullable link provenance columns without changing existing links", async () => {
  const client = await createClient({ files: baseMigrations });
  try {
    await client.query(
      `INSERT INTO erc20_tokens_bridge_relationships (
         source_chain_id, source_token_address, source_bridge_address,
         dest_chain_id, dest_token_address
       ) VALUES (1, 16, NULL, 8453, 32)`,
    );

    await runMigrations(client, {
      files: ["00135_erc20_bridge_link_provenance"],
    });

    const { rows: columns } = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'erc20_tokens_bridge_relationships'
         AND column_name IN (
           'relationship', 'bridge_name', 'source_name', 'source_url',
           'inferred_reverse'
         )
       ORDER BY column_name`,
    );
    expect(columns).toEqual([
      { column_name: "bridge_name", data_type: "text", is_nullable: "YES" },
      {
        column_name: "inferred_reverse",
        data_type: "boolean",
        is_nullable: "YES",
      },
      { column_name: "relationship", data_type: "text", is_nullable: "YES" },
      { column_name: "source_name", data_type: "text", is_nullable: "YES" },
      { column_name: "source_url", data_type: "text", is_nullable: "YES" },
    ]);

    const {
      rows: [link],
    } = await client.query<{
      dest_token_address: string;
      relationship: string | null;
    }>(
      `SELECT dest_token_address::text, relationship
       FROM erc20_tokens_bridge_relationships`,
    );
    expect(link).toEqual({ dest_token_address: "32", relationship: null });

    await client.query(
      `UPDATE erc20_tokens_bridge_relationships
       SET relationship = 'native_issuer', bridge_name = 'Circle',
           source_name = 'Circle USDC contract addresses',
           source_url = 'https://developers.circle.com/stablecoins/usdc-contract-addresses',
           inferred_reverse = FALSE`,
    );
    await expect(
      client.query(
        `UPDATE erc20_tokens_bridge_relationships SET relationship = 'wrapped'`,
      ),
    ).rejects.toThrow(/erc20_tokens_bridge_relationships_relationship_kind/);
  } finally {
    await client.close();
  }
});
