import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

// 00120-00122 run in one transaction against live writers and take locks on
// ~20 relations. The first deploy attempt deadlocked against a worker
// (blocks vs indexer_cursor, 2026-09-05). Parking the workers by locking
// blocks before anything else is what makes the set deadlock-free, and it only
// works if it really is the first statement. Guard that, since nothing else
// would notice it moving.
async function leadingStatements(migration: string) {
  const file = path.resolve(process.cwd(), `migrations/${migration}/index.sql`);
  const sql = await fs.readFile(file, "utf8");
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && line.trim() !== "")
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
}

// Every migration that takes a lock conflicting with ROW EXCLUSIVE on a table
// the workers write mid-transaction -- CREATE INDEX (SHARE), CREATE TRIGGER
// (SHARE ROW EXCLUSIVE), ALTER TABLE ... ADD COLUMN / DISABLE TRIGGER, DROP,
// CREATE OR REPLACE VIEW over them -- has to park the workers first. Note that
// a lock of that kind is held until COMMIT, so "placing it first" does not
// shorten the stall; only parking makes the ordering safe. ANALYZE and
// ALTER TABLE ... SET (reloptions) take SHARE UPDATE EXCLUSIVE, which does not
// conflict with the workers, and migrations consisting only of those (00125)
// need no lock. Add to this list when adding a conflicting one.
for (const migration of [
  "00120_incremental_rewards_by_position",
  "00123_pool_last_event_id",
]) {
  test(`${migration} parks the indexer workers before taking any other lock`, async () => {
    expect(await leadingStatements(migration)).toEqual([
      "SET LOCAL lock_timeout = '15min'",
      "LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE",
    ]);
  });
}
