import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

async function reloptions(client: Client, table: string) {
  const { rows } = await client.query<{ reloptions: string[] | null }>(
    `SELECT reloptions FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
    [table]
  );
  return rows[0]?.reloptions ?? [];
}

test("hot tables carry an aggressive autovacuum scale factor and fillfactor", async () => {
  const client = await createClient();

  for (const [table, fillfactor] of [
    ["pool_states", "fillfactor=70"],
    ["pool_tvl", "fillfactor=70"],
    ["erc20_tokens_latest_price", "fillfactor=80"],
  ] as const) {
    const options = await reloptions(client, table);
    expect(options).toContain("autovacuum_vacuum_scale_factor=0.01");
    expect(options).toContain(fillfactor);
  }
});

test("the valid_until index is gone so latest-price updates can go HOT", async () => {
  const client = await createClient();

  const { rows } = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'erc20_tokens_latest_price'`
  );
  const names = rows.map((row) => row.indexname);

  expect(names).not.toContain("erc20_tokens_latest_price_valid_until_idx");
  // The primary key is what recompute_erc20_token_latest_price upserts against
  // and must survive; without it the ON CONFLICT target disappears.
  expect(names).toContain("erc20_tokens_latest_price_pkey");
});
