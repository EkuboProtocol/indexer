import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations, runMigrationsThrough } from "../helpers/db.js";

const V2_CORE = BigInt("0xe0e0e08a6a4b9dc7bd67bcb7aade5cf48157d444");
const EXTENSION = BigInt("0x553a2efc570c9e104942cec6ac1c18118e54c091");

test("pool_config written by 00065 is normalized to an integer", async () => {
  const client = new PGlite("memory://pool-config-integer-scale");
  try {
    await runMigrationsThrough(client, 64);

    const fee = 184467440737096n;
    const tickSpacing = 10n;
    await client.query(
      `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1,
          fee, fee_denominator, tick_spacing, pool_extension)
       VALUES (1, $1, 2000, 0, 3001, $2, $3, $4, $5)`,
      [
        V2_CORE.toString(),
        fee.toString(),
        (1n << 64n).toString(),
        Number(tickSpacing),
        EXTENSION.toString(),
      ]
    );

    const read = async () =>
      (
        await client.query<{ pool_config: string; scale: number }>(
          `SELECT pool_config::text AS pool_config, scale(pool_config) AS scale
           FROM pool_keys`
        )
      ).rows[0];

    await runMigrations(client, { files: ["00065_fix_pool_config_core_offset"] });
    const before = await read();
    // The state production was in: an integral value with a fractional scale.
    expect(before.scale).toBeGreaterThan(0);
    expect(() => BigInt(before.pool_config)).toThrow();

    await runMigrations(client, { files: ["00131_pool_config_integer_scale"] });
    const after = await read();
    expect(after.scale).toBe(0);
    expect(BigInt(after.pool_config)).toBe(
      (EXTENSION << 96n) + (fee << 32n) + tickSpacing
    );
  } finally {
    await client.close();
  }
});
