import { expect, test } from "bun:test";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

async function reloptions(client: Client, schema: string, table: string) {
  const { rows } = await client.query<{ reloptions: string[] | null }>(
    `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
    [schema, table]
  );
  return rows[0]?.reloptions ?? [];
}

test("the price-source table gets the anti-bloat treatment 00119 gave latest_price", async () => {
  const client = await createClient();
  const options = await reloptions(client, "public", "erc20_tokens_latest_price_by_source");
  expect(options).toContain("autovacuum_vacuum_scale_factor=0.01");
  expect(options).toContain("fillfactor=70");
});

test("the big event and hourly tables re-analyze at 1% churn instead of 10%", async () => {
  const client = await createClient();
  for (const [schema, table] of [
    ["public", "nonfungible_token_transfers"],
    ["public", "nonfungible_token_owners"],
    ["public", "protocol_fees_paid"],
    ["public", "position_fees_collected"],
    ["public", "position_updates"],
    ["public", "pool_balance_change"],
    ["public", "swaps"],
    ["public", "hourly_volume_by_token"],
    ["public", "hourly_tvl_delta_by_token"],
    ["public", "hourly_price_data"],
    ["incentives", "computed_rewards"],
  ] as const) {
    expect(await reloptions(client, schema, table)).toContain("autovacuum_analyze_scale_factor=0.01");
  }
});

test("the positions-history lookup by token is an index probe, not a scan of the chain", async () => {
  const client = await createClient();
  await ensureIndexerCursor(client, 7);

  // 40,000 transfers on one chain, ~10 per token, the shape production has.
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     SELECT 7, b, b, '2024-01-01T00:00:00Z'::timestamptz + (b || ' seconds')::interval, 1
     FROM generate_series(1, 4000) b`
  );
  await client.query(
    `INSERT INTO nonfungible_token_transfers
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, token_id, from_address, to_address)
     -- (block_number, transaction_index) is unique per i, so the generated
     -- event_id primary key never collides; token_id repeats every 4000 rows,
     -- giving ~10 transfers per token.
     SELECT 7, (i % 4000) + 1, i / 4000, 0, i, 999, (i % 4000) + 1, i, i + 1
     FROM generate_series(0, 39999) i`
  );
  await client.query(`ANALYZE nonfungible_token_transfers`);

  const { rows } = await client.query<{ "QUERY PLAN": string }>(
    `EXPLAIN SELECT nft.transaction_hash, nft.block_number
     FROM nonfungible_token_transfers nft
     LEFT JOIN nft_locker_mappings nlm ON nlm.nft_address = nft.emitter AND nlm.chain_id = nft.chain_id
     WHERE nft.token_id = 1234 AND nft.chain_id = 7 AND (nft.emitter = 999 OR nlm.locker = 999)`
  );
  const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
  expect(plan).toContain("nonfungible_token_transfers_chain_id_token_id_idx");
  expect(plan).not.toMatch(/Seq Scan on nonfungible_token_transfers/);
});
