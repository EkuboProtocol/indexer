import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

async function refresh(client: Client) {
  const { rows } = await client.query<{
    refresh_rewards_by_position_if_stale: boolean;
  }>(`SELECT incentives.refresh_rewards_by_position_if_stale()`);
  return rows[0]!.refresh_rewards_by_position_if_stale;
}

async function state(client: Client) {
  const { rows } = await client.query<{
    stale: boolean;
    refresh_count: number;
    skip_count: number;
  }>(
    `SELECT stale, refresh_count::int AS refresh_count, skip_count::int AS skip_count
     FROM incentives.rewards_mv_refresh_state`
  );
  return rows[0]!;
}

test("every relation the rewards matview reads marks it stale when written", async () => {
  const client = await createClient();

  const { rows } = await client.query<{ relname: string; count: number }>(
    `SELECT c.relname, COUNT(*)::int AS count
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE p.proname = 'mark_rewards_by_position_stale'
       AND NOT t.tgisinternal
     GROUP BY c.relname
     ORDER BY c.relname`
  );

  // The matview's defining query reads exactly these four relations. Missing
  // one means a write to it would be silently skipped forever.
  expect(rows.map((row) => row.relname)).toEqual([
    "campaign_reward_periods",
    "campaigns",
    "computed_rewards",
    "generated_drop_reward_periods",
  ]);

  // One trigger for INSERT/UPDATE/DELETE, one for TRUNCATE.
  for (const row of rows) {
    expect(row.count).toBe(2);
  }
});

test("the refresh runs once, then skips until an input is written", async () => {
  const client = await createClient();

  // Seeded stale, so the first call after deployment always refreshes.
  expect(await refresh(client)).toBe(true);
  expect(await state(client)).toMatchObject({
    stale: false,
    refresh_count: 1,
    skip_count: 0,
  });

  // Nothing has been written since, so this is the case that used to cost
  // ~145 s of CPU and now costs nothing.
  expect(await refresh(client)).toBe(false);
  expect(await refresh(client)).toBe(false);
  expect(await state(client)).toMatchObject({
    stale: false,
    refresh_count: 1,
    skip_count: 2,
  });
});

test("a delete that rewrites a period is caught even when the row count is unchanged", async () => {
  const client = await createClient();

  await refresh(client);
  expect((await state(client)).stale).toBe(false);

  // compute_rewards_for_period_v1 clears a period with exactly this shape
  // before re-inserting it, which is why a max(id)/count(*) watermark cannot
  // be used here: both are identical either side of a recompute. The
  // statement-level trigger fires regardless of how many rows matched.
  await client.query(
    `DELETE FROM incentives.computed_rewards WHERE campaign_reward_period_id = -1`
  );

  expect((await state(client)).stale).toBe(true);
  expect(await refresh(client)).toBe(true);
  expect(await state(client)).toMatchObject({ stale: false, refresh_count: 2 });
});

test("the cron job calls the guard rather than refreshing unconditionally", async () => {
  const client = await createClient();

  // pg_cron is not available under PGlite, so the migration's scheduling block
  // is skipped there; assert on the function it would have been pointed at.
  const { rows } = await client.query<{ prosrc: string }>(
    `SELECT prosrc FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'incentives'
       AND p.proname = 'refresh_rewards_by_position_if_stale'`
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]!.prosrc).toContain(
    "REFRESH MATERIALIZED VIEW CONCURRENTLY"
  );
});
