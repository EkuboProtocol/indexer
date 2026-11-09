import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import shift from "postgres-shift";

const SERVER = process.env.TEST_PG_CONNECTION_STRING;

describe.skipIf(!SERVER)("DAO persistence across worker exits", () => {
  const database = `dao_persistence_${process.pid}_${Date.now()}`;
  let admin: Sql;
  let sql: Sql;
  let connectionString: string;

  beforeAll(async () => {
    admin = postgres(SERVER!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const url = new URL(SERVER!);
    url.pathname = `/${database}`;
    connectionString = url.toString();
    sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    await shift({ sql, path: resolve("migrations") });
    // A second startup must see the migration ledger, not reapply schema SQL.
    const [before] = await sql`SELECT count(*)::int AS count FROM migrations`;
    await shift({ sql, path: resolve("migrations") });
    const [after] = await sql`SELECT count(*)::int AS count FROM migrations`;
    expect(after?.count).toBe(before?.count);
    await sql`
      INSERT INTO indexer_cursor (chain_id, order_key, last_updated)
      VALUES (1, 0, NOW())
    `;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  async function worker(action: string) {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/daoPersistence.ts", action],
      {
        env: { ...process.env, TEST_PG_CONNECTION_STRING: connectionString },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(errors).toBe("");
    expect(code, output + errors).toBe(0);
    return JSON.parse(output) as { orderKey: string; uniqueKey: string };
  }

  test("preserves transaction contracts and durable cursors across worker exits", async () => {
    const hash = (1n << 255n) + 123n;
    const expected = { orderKey: "100", uniqueKey: `0x${hash.toString(16)}` };
    expect(await worker("commit")).toEqual(expected);
    expect(await worker("read")).toEqual(expected);
    expect(await worker("contract")).toEqual(expected);
    expect(await worker("read")).toEqual(expected);
    expect(await worker("rollback")).toEqual(expected);
    expect(await worker("read")).toEqual(expected);

    const rows = await sql`
      SELECT block_number::text, block_hash::text, block_time
      FROM blocks WHERE chain_id = 1 ORDER BY block_number
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.block_number).toBe("100");
    expect(rows[0]?.block_hash).toBe(hash.toString());
    expect(rows[0]?.block_time).toEqual(new Date("2026-11-02T00:00:00.000Z"));
    const [head] = await sql`
      SELECT head_base_fee_per_gas::text, public.get_chain_head_time(1) AS time
      FROM indexer_cursor WHERE chain_id = 1
    `;
    expect(head?.head_base_fee_per_gas).toBe("12345678901234567890");
    expect(head?.time).toEqual(new Date("2026-11-02T00:00:00.000Z"));
  }, 30_000);
});
