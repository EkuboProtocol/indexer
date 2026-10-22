import type { PGlite } from "@electric-sql/pglite";
import { DAO } from "../../src/_shared/dao";

// Just enough of postgres.js's tagged-template `sql` for DAO methods that use
// plain parameters and `sql.typed`, run against PGlite. Results carry `count`
// like postgres.js does. Not a general adapter: fragments, helpers and
// transactions are not supported.
function toParam(value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function createPgliteDao(client: PGlite, chainId: bigint): DAO {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, part, i) => acc + (i === 0 ? "" : `$${i}`) + part,
      "",
    );
    const result = await client.query(text, values.map(toParam));
    return Object.assign([...result.rows], {
      count: result.affectedRows ?? result.rows.length,
    });
  };
  sql.typed = (value: unknown) => value;
  return new (DAO as unknown as new (sql: unknown, chainId: bigint) => DAO)(
    sql,
    chainId,
  );
}
