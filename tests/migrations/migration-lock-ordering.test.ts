import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

// 00120-00122 run in one transaction against live writers and take locks on
// ~20 relations. The first deploy attempt deadlocked against a worker
// (blocks vs indexer_cursor, 2026-09-05). Parking the workers by locking
// blocks before anything else is what makes the set deadlock-free, and it only
// works if it really is the first statement. Guard that, since nothing else
// would notice it moving.
test("00120 parks the indexer workers before taking any other lock", async () => {
  const file = path.resolve(
    process.cwd(),
    "migrations/00120_incremental_rewards_by_position/index.sql"
  );
  const sql = await fs.readFile(file, "utf8");

  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && line.trim() !== "")
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  expect(statements[0]).toBe("SET LOCAL lock_timeout = '15min'");
  expect(statements[1]).toBe("LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE");
});
