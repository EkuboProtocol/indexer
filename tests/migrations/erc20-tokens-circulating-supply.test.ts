import { expect, test } from "bun:test";
import { createClient, runMigrations } from "../helpers/db.js";

test("adds nullable non-negative integer supply without changing token rows", async () => {
  const client = await createClient({ files: ["00018_tokens"] });
  try {
    await client.query(
      `INSERT INTO erc20_tokens (
         chain_id, token_address, token_symbol, token_name, token_decimals,
         visibility_priority, sort_order, total_supply
       ) VALUES (1, 123, 'TKN', 'Token', 6, 1, 0, 1000000)`,
    );

    await runMigrations(client, {
      files: ["00114_erc20_tokens_circulating_supply"],
    });

    const {
      rows: [column],
    } = await client.query<{
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'erc20_tokens'
         AND column_name = 'circulating_supply'`,
    );
    expect(column).toEqual({ data_type: "numeric", is_nullable: "YES" });

    const {
      rows: [token],
    } = await client.query<{
      total_supply: string;
      circulating_supply: string | null;
    }>(
      `SELECT total_supply::text, circulating_supply::text
       FROM erc20_tokens
       WHERE chain_id = 1 AND token_address = 123`,
    );
    expect(token).toEqual({
      total_supply: "1000000",
      circulating_supply: null,
    });

    await client.query(
      `UPDATE erc20_tokens
       SET circulating_supply = 750000
       WHERE chain_id = 1 AND token_address = 123`,
    );
    await expect(
      client.query(
        `UPDATE erc20_tokens
         SET circulating_supply = -1
         WHERE chain_id = 1 AND token_address = 123`,
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `UPDATE erc20_tokens
         SET circulating_supply = 1.5
         WHERE chain_id = 1 AND token_address = 123`,
      ),
    ).rejects.toThrow();
  } finally {
    await client.close();
  }
});
