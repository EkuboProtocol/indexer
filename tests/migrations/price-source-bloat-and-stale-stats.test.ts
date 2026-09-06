import { expect, test } from "bun:test";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

async function reloptions(client: Client, table: string) {
  const { rows } = await client.query<{ reloptions: string[] | null }>(
    `SELECT reloptions FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
    [table]
  );
  return rows[0]?.reloptions ?? [];
}

test("the price-source table gets HOT headroom for after its repack", async () => {
  const client = await createClient();
  const options = await reloptions(client, "erc20_tokens_latest_price_by_source");
  expect(options).toContain("fillfactor=70");
  expect(options).toContain("autovacuum_vacuum_scale_factor=0.01");
});

test("the four stale-statistics tables re-analyze at 1% churn instead of 10%", async () => {
  const client = await createClient();
  for (const table of [
    "nonfungible_token_transfers",
    "nonfungible_token_owners",
    "protocol_fees_paid",
    "position_fees_collected",
  ]) {
    expect(await reloptions(client, table)).toContain("autovacuum_analyze_scale_factor=0.01");
  }
  // Deliberately not on the list: they autoanalyze at the default threshold
  // every few days already, and a 1% threshold would just re-sample them.
  for (const table of ["hourly_price_data", "hourly_volume_by_token", "swaps"]) {
    expect(await reloptions(client, table)).not.toContain("autovacuum_analyze_scale_factor=0.01");
  }
});

async function seedTransfers(client: Client, chainId: number) {
  await ensureIndexerCursor(client, chainId);
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     SELECT $1::bigint, b, $1::bigint * 100000 + b, '2024-01-01T00:00:00Z'::timestamptz + (b || ' seconds')::interval, 1
     FROM generate_series(1, 4000) b`,
    [chainId]
  );
  // (block_number, transaction_index) is unique per i, so the generated
  // event_id primary key never collides; token_id repeats every 4000 rows,
  // giving ~10 transfers per token. Two emitters, so the planner has something
  // to skip over.
  await client.query(
    `INSERT INTO nonfungible_token_transfers
       (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, token_id, from_address, to_address)
     SELECT $1::bigint, (i % 4000) + 1, i / 4000, 0, $1::bigint * 1000000 + i, 900 + (i % 2), (i % 4000) + 1, i, i + 1
     FROM generate_series(0, 39999) i`,
    [chainId]
  );
}

function transfersRowEstimate(plan: string) {
  const m = plan.match(/on nonfungible_token_transfers nft\s+\(cost=[^ ]+ rows=(\d+)/);
  return m ? Number(m[1]) : null;
}

const POSITIONS_HISTORY_LOOKUP = `
  EXPLAIN SELECT nft.transaction_hash, nft.block_number
  FROM nonfungible_token_transfers nft
  LEFT JOIN nft_locker_mappings nlm ON nlm.nft_address = nft.emitter AND nlm.chain_id = nft.chain_id
  WHERE nft.token_id = 1234 AND nft.chain_id = 7 AND (nft.emitter = 900 OR nlm.locker = 900)`;

async function plan(client: Client) {
  const { rows } = await client.query<{ "QUERY PLAN": string }>(POSITIONS_HISTORY_LOOKUP);
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
}

test("stale statistics, not a missing index, are what made the positions-history lookup scan a chain", async () => {
  const client = await createClient();

  // Production's failure mode: statistics gathered before a chain existed,
  // then that chain's rows arrive. Statistics are present (another chain's),
  // so the planner trusts them and estimates ONE row for the new chain --
  // which makes an index on chain_id alone look free, and token_id a filter.
  await seedTransfers(client, 8);
  await client.query(`ANALYZE nonfungible_token_transfers`);
  await seedTransfers(client, 7);
  expect(transfersRowEstimate(await plan(client))).toBe(1);

  // ANALYZE alone repairs it: the estimate becomes the real ~10 transfers per
  // token, and the existing (chain_id, emitter, token_id, ...) index serves
  // chain_id + token_id by skip scan, with token_id in the index condition
  // rather than a filter over the chain.
  await client.query(`ANALYZE nonfungible_token_transfers`);
  const fresh = await plan(client);
  expect(transfersRowEstimate(fresh)).toBeGreaterThanOrEqual(5);
  expect(fresh).toContain("nonfungible_token_transfers_chain_id_emitter_token_id_event_idx");
  expect(fresh).toMatch(/Index Cond:.*token_id = '?1234/);
  expect(fresh).not.toContain("idx_nonfungible_token_transfers_chain_block");
});
