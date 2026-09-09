import { expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { DAO } from "./dao";

it("rewinding clears orphaned finality and gas while recovery reads stay chain-scoped", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE indexer_cursor (
        chain_id bigint PRIMARY KEY, order_key bigint, unique_key numeric,
        last_updated timestamptz, finalized_order_key bigint, finalized_unique_key numeric,
        head_block_number bigint, head_block_hash numeric, head_block_time timestamptz,
        head_base_fee_per_gas numeric
      );
      CREATE TABLE blocks (chain_id bigint, block_number bigint, block_hash numeric);
      INSERT INTO blocks VALUES (1, 50, 50), (1, 80, 80), (2, 99, 999);
    `);
    // Execute the DAO's actual parameterized SQL against Postgres in PGlite.
    const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.reduce((q, part, i) => q + (i ? `$${i}` : "") + part, "");
      const result = await db.query(query, values.map(v => typeof v === "bigint" ? v.toString() : v));
      return Object.assign(result.rows, { count: result.affectedRows });
    }, { typed: (value: unknown) => value });
    const dao = Reflect.construct(DAO, [sql, 1n]) as DAO;
    const high = { orderKey: 100n, uniqueKey: "0x64" };
    await dao.writeCursor(high, { orderKey: 0n }, { number: 100, hash: 100n, time: new Date(), baseFeePerGas: 7n });
    await dao.updateFinalizedCursor(high, { orderKey: 95n, uniqueKey: "0x5f" });
    await dao.writeCursor({ orderKey: 90n, uniqueKey: "0x5a" }, high);
    const { rows } = await db.query("SELECT finalized_order_key, finalized_unique_key, head_base_fee_per_gas FROM indexer_cursor");
    expect(rows).toEqual([{ finalized_order_key: null, finalized_unique_key: null, head_base_fee_per_gas: null }]);
    expect(await dao.loadPreviousBlockCursor(90)).toEqual({ orderKey: 80n, uniqueKey: "0x50" });
    expect(await dao.loadPreviousBlockCursor(80)).toEqual({ orderKey: 50n, uniqueKey: "0x32" });
  } finally {
    await db.close();
  }
});
