import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

async function seedCursor(client: Client, chainId: number) {
  await client.query(
    `INSERT INTO indexer_cursor (chain_id, order_key, unique_key, last_updated, fork_counter)
     VALUES ($1, 0, NULL, NOW(), 0)
     ON CONFLICT (chain_id) DO NOTHING`,
    [chainId]
  );
}

test("indexer_cursor carries the chain head as typed columns", async () => {
  const client = await createClient();

  const { rows } = await client.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'indexer_cursor'
       AND column_name LIKE 'head_%'
     ORDER BY column_name`
  );

  // Typed columns rather than a json blob: block_hash is a 256-bit NUMERIC and
  // would lose precision through any standard json parser.
  expect(rows).toEqual([
    {
      column_name: "head_base_fee_per_gas",
      data_type: "numeric",
      is_nullable: "YES",
    },
    { column_name: "head_block_hash", data_type: "numeric", is_nullable: "YES" },
    { column_name: "head_block_number", data_type: "bigint", is_nullable: "YES" },
    {
      column_name: "head_block_time",
      data_type: "timestamp with time zone",
      is_nullable: "YES",
    },
  ]);
});

test("the migration removes the empty blocks already stored", async () => {
  const client = await createClient();

  // Nothing should be left that a cascade could never match a child for.
  const { rows } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM blocks WHERE num_events = 0`
  );
  expect(rows[0]!.count).toBe(0);
});

test("the empty block sweep and the index that served it are gone", async () => {
  const client = await createClient();

  const { rows: fn } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'delete_old_empty_blocks'`
  );
  expect(fn[0]!.count).toBe(0);

  const { rows: idx } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM pg_indexes
     WHERE indexname = 'blocks_num_events_block_time_idx'`
  );
  expect(idx[0]!.count).toBe(0);
});

test("get_chain_head_time prefers the cursor and falls back to blocks", async () => {
  const client = await createClient();
  await seedCursor(client, 7);

  // No head recorded yet and no blocks: nothing to report.
  const { rows: empty } = await client.query<{ head: string | null }>(
    `SELECT public.get_chain_head_time(7) AS head`
  );
  expect(empty[0]!.head).toBeNull();

  // A chain that has not produced a block since the migration still resolves
  // through blocks.
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, base_fee_per_gas, num_events)
     VALUES (7, 100, 1, '2024-03-01T00:00:00Z', 1, 1)`
  );
  const { rows: viaBlocks } = await client.query<{ head: Date }>(
    `SELECT public.get_chain_head_time(7) AS head`
  );
  expect(new Date(viaBlocks[0]!.head).toISOString()).toBe(
    "2024-03-01T00:00:00.000Z"
  );

  // Once the head is recorded it wins, which is the whole point: it advances
  // on empty blocks, which write no blocks row at all.
  await client.query(
    `UPDATE indexer_cursor
     SET head_block_number = 250, head_block_time = '2024-03-02T00:00:00Z'
     WHERE chain_id = 7`
  );
  const { rows: viaCursor } = await client.query<{ head: Date }>(
    `SELECT public.get_chain_head_time(7) AS head`
  );
  expect(new Date(viaCursor[0]!.head).toISOString()).toBe(
    "2024-03-02T00:00:00.000Z"
  );
});

test("reward period readiness follows the cursor head, not the last event block", async () => {
  const client = await createClient();
  await seedCursor(client, 7);

  // compute_pending_reward_periods used MAX(block_time) over blocks. On a
  // chain whose blocks are all empty that watermark would never advance once
  // empty blocks stop being written, and reward periods would never compute.
  const { rows } = await client.query<{ prosrc: string }>(
    `SELECT prosrc FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'incentives'
       AND p.proname = 'compute_pending_reward_periods'`
  );
  expect(rows[0]!.prosrc).toContain("get_chain_head_time");
  expect(rows[0]!.prosrc).not.toContain("MAX(block_time)");
});

test("the 'blocks' notification follows the head, not the blocks table", async () => {
  const client = await createClient();

  // quoter-service LISTENs on 'blocks' and re-syncs when it fires. If that
  // stayed on the blocks insert it would stop hearing about empty blocks, and
  // on a quiet chain its cached base_fee_per_gas would go stale. The head
  // updates once per block either way, so notifying from there keeps the old
  // cadence exactly.
  const { rows: insert } = await client.query<{ prosrc: string }>(
    `SELECT prosrc FROM pg_proc WHERE proname = 'notify_blocks_insert'`
  );
  expect(insert[0]!.prosrc).toContain("blocks_insert");
  expect(insert[0]!.prosrc).not.toContain("pg_notify('blocks'");

  const { rows: head } = await client.query<{ prosrc: string }>(
    `SELECT prosrc FROM pg_proc WHERE proname = 'notify_indexer_cursor_head'`
  );
  expect(head[0]!.prosrc).toContain("pg_notify('blocks'");

  const { rows: trg } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'indexer_cursor'
       AND t.tgname = 'indexer_cursor_head_notification'
       AND NOT t.tgisinternal`
  );
  expect(trg[0]!.count).toBe(1);
});

test("rewinding the cursor clears the head rather than keeping the orphaned one", async () => {
  const client = await createClient();
  await seedCursor(client, 7);
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, base_fee_per_gas, num_events)
     VALUES (7, 100, 1, '2024-03-01T00:00:00Z', 1, 1)`
  );
  await client.query(
    `UPDATE indexer_cursor
     SET order_key = 105, head_block_number = 105, head_block_hash = 999,
         head_block_time = '2024-03-01T00:05:00Z', head_base_fee_per_gas = 7
     WHERE chain_id = 7`
  );

  // After a reset to 100, block 105 is on the discarded fork. A reader that
  // kept seeing it would report an orphaned height and hash.
  await client.query(`SELECT reset_indexer_cursor(7, 100)`);

  const { rows } = await client.query<{
    order_key: string;
    head_block_number: string | null;
    head_block_hash: string | null;
    head_block_time: string | null;
  }>(
    `SELECT order_key::text, head_block_number::text, head_block_hash::text,
            head_block_time::text
     FROM indexer_cursor WHERE chain_id = 7`
  );
  expect(rows[0]).toEqual({
    order_key: "100",
    head_block_number: null,
    head_block_hash: null,
    head_block_time: null,
  });

  // And the accessor falls through to blocks, so nothing downstream sees a
  // gap either.
  const { rows: head } = await client.query<{ head: Date }>(
    `SELECT public.get_chain_head_time(7) AS head`
  );
  expect(new Date(head[0]!.head).toISOString()).toBe(
    "2024-03-01T00:00:00.000Z"
  );
});

test("the oracle TWAP window ends at the chain head", async () => {
  const client = await createClient();

  const { rows } = await client.query<{ prosrc: string }>(
    `SELECT prosrc FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_oracle_twap_tick'`
  );
  // Otherwise every TWAP on a quiet chain silently shortens to the last block
  // that happened to carry an event.
  expect(rows[0]!.prosrc).toContain("get_chain_head_time");
});
