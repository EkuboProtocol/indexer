import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createClient, ensureIndexerCursor, runMigrationsThrough, runMigrations } from "../helpers/db";

type Client = Awaited<ReturnType<typeof createClient>>;

test("migration leaves optimized pool views and their driving index untouched", async () => {
  const db = new PGlite();
  try {
    await runMigrationsThrough(db, 128);
    const inspect = () => db.query(`SELECT pg_get_viewdef('all_pool_states_view'::regclass) AS view,
      pg_get_functiondef('recompute_pool_last_event_id(bigint)'::regprocedure) AS maintainer,
      pg_get_indexdef('pool_last_event_id_chain_id_core_address_last_event_id_idx'::regclass) AS index`);
    const before = await inspect();
    await runMigrations(db, { files: ["00129_starknet_extension_call_points"] });
    expect((await inspect()).rows).toEqual(before.rows);
  } finally { await db.close(); }
});

async function event(db: Client, block: number, mask: number, extension = 42, core = 2000) {
  await ensureIndexerCursor(db, 7);
  await db.query(`INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
    VALUES (7, $1::bigint, $1::bigint::numeric, now(), 1) ON CONFLICT DO NOTHING`, [block]);
  await db.query(`INSERT INTO starknet_extension_call_points
    (chain_id, block_number, transaction_index, event_index, transaction_hash,
     emitter, pool_extension, call_points)
    VALUES (7, $1, 0, 0, 123, $2, $3, $4)`, [block, core, extension, mask]);
}

async function eligible(db: Client) {
  const { rows } = await db.query<{ extensions: string[] }>(
    `SELECT eligible_extensions::text[] AS extensions
     FROM starknet_extension_call_points_backfill WHERE chain_id=7 AND core_address=2000`);
  return rows[0]?.extensions ?? null;
}

async function complete(db: Client) {
  await db.query(`INSERT INTO starknet_extension_call_points_backfill
    (chain_id, core_address, through_block) VALUES (7, 2000, 10)`);
  await db.query(`SELECT refresh_starknet_extension_routing(7, 2000)`);
}

test("latest canonical flags win, backfill is fail-closed, reorg restores previous flags", async () => {
  const db = await createClient();
  try {
    await event(db, 10, 17);
    expect(await eligible(db)).toBeNull();
    await complete(db);
    expect(await eligible(db)).toEqual(["42"]);

    // Re-registration enables before_swap, without any pool event.
    await event(db, 20, 81);
    expect(await eligible(db)).toEqual([]);
    // Out-of-order historical safe registration must not resurrect the pool.
    await event(db, 5, 17);
    expect(await eligible(db)).toEqual([]);

    await db.query(`DELETE FROM blocks WHERE chain_id=7 AND block_number=20`);
    expect(await eligible(db)).toEqual(["42"]);
    // after_swap alone is also excluded.
    await event(db, 30, 33);
    expect(await eligible(db)).toEqual([]);
    await event(db, 40, 17);
    expect(await eligible(db)).toEqual(["42"]);

    await db.query(`DELETE FROM blocks WHERE chain_id=7`);
    expect(await eligible(db)).toEqual([]);
  } finally { await db.close(); }
});

test("eligibility is scoped to Core and returns a canonical sorted set", async () => {
  const db = await createClient();
  try {
    await complete(db);
    await event(db, 10, 17, 99);
    await event(db, 11, 1, 42);
    await event(db, 12, 64, 42, 2001);
    expect(await eligible(db)).toEqual(["42", "99"]);
    await event(db, 13, 4, 42);
    expect(await eligible(db)).toEqual(["42", "99"]);
  } finally { await db.close(); }
});
