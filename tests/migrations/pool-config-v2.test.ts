import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../helpers/db.js";

const BASE_MIGRATIONS = ["00001_chain_tables", "00002_core_tables"] as const;
const EVM_POOL_FEE_DENOMINATOR = 1n << 64n;
const STARKNET_POOL_FEE_DENOMINATOR = 1n << 128n;

function computeConcentratedPoolConfig({
  fee,
  tickSpacing,
  extension,
}: {
  fee: bigint;
  tickSpacing: bigint;
  extension: bigint;
}) {
  const extensionShift = 96n;
  const feeShift = 32n;
  const typeBit = 31n;
  return (
    (extension << extensionShift) +
    (fee << feeShift) +
    tickSpacing +
    (1n << typeBit)
  );
}

test("pool_config metadata is backfilled for existing pools", async () => {
  const client = new PGlite("memory://pool-config-v2");
  try {
    await runMigrations(client, { files: [...BASE_MIGRATIONS] });

    const chainId = 1;
    const poolExtension = 5000n;
    const fee = 100n;
    const tickSpacing = 60n;

    const {
      rows: [{ pool_key_id }],
    } = await client.query<{ pool_key_id: bigint }>(
      `INSERT INTO pool_keys (
          chain_id,
          core_address,
          pool_id,
          token0,
          token1,
          fee,
          fee_denominator,
          tick_spacing,
          pool_extension
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING pool_key_id`,
      [
        chainId,
        "1000",
        "2000",
        "3000",
        "3001",
        fee.toString(),
        EVM_POOL_FEE_DENOMINATOR.toString(),
        Number(tickSpacing),
        poolExtension.toString(),
      ]
    );

    await runMigrations(client, { files: ["00060_pool_config_v2"] });

    const {
      rows: [{ pool_config, pool_config_type }],
    } = await client.query<{ pool_config: string | bigint; pool_config_type: string }>(
      `SELECT pool_config, pool_config_type
       FROM pool_keys
       WHERE pool_key_id = $1`,
      [pool_key_id]
    );

    const poolConfigValue =
      typeof pool_config === "bigint"
        ? pool_config
        : BigInt(pool_config.split(".")[0]);

    expect(poolConfigValue).toBe(
      computeConcentratedPoolConfig({
        fee,
        tickSpacing,
        extension: poolExtension,
      })
    );
    expect(pool_config_type).toBe("concentrated");
  } finally {
    await client.close();
  }
});

test("starknet pools keep pool_config null after the migration", async () => {
  const client = new PGlite("memory://pool-config-v2-starknet");
  try {
    await runMigrations(client, { files: [...BASE_MIGRATIONS] });

    const {
      rows: [{ pool_key_id }],
    } = await client.query<{ pool_key_id: bigint }>(
      `INSERT INTO pool_keys (
          chain_id,
          core_address,
          pool_id,
          token0,
          token1,
          fee,
          fee_denominator,
          tick_spacing,
          pool_extension
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING pool_key_id`,
      [
        100,
        "1000",
        "2000",
        "3000",
        "3001",
        "10",
        STARKNET_POOL_FEE_DENOMINATOR.toString(),
        60,
        "5000",
      ]
    );

    await runMigrations(client, { files: ["00060_pool_config_v2"] });

    const { rows } = await client.query<
      { pool_config: string | null; pool_config_type: string }[]
    >(
      `SELECT pool_config, pool_config_type
       FROM pool_keys
       WHERE pool_key_id = $1`,
      [pool_key_id]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].pool_config).toBeNull();
    expect(rows[0].pool_config_type).toBe("concentrated");
  } finally {
    await client.close();
  }
});

test("stableswap amplification constraint enforces bounds", async () => {
  const client = new PGlite("memory://pool-config-v2-amplification");
  try {
    await runMigrations(client, { files: [...BASE_MIGRATIONS] });
    await runMigrations(client, { files: ["00060_pool_config_v2"] });

    await expect(
      client.query(
        `INSERT INTO pool_keys (
            chain_id,
            core_address,
            pool_id,
            token0,
            token1,
            fee,
            fee_denominator,
            tick_spacing,
            pool_extension,
            stableswap_amplification
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          1,
          "1000",
          "2000",
          "3000",
          "3001",
          "1",
          EVM_POOL_FEE_DENOMINATOR.toString(),
          60,
          "4000",
          30, // invalid amplification (>26)
        ]
      )
    ).rejects.toThrow(/stableswap_amplification_bounds/);
  } finally {
    await client.close();
  }
});

test("concentrated pools must provide tick spacing", async () => {
  const client = new PGlite("memory://pool-config-v2-concentrated-tick");
  try {
    await runMigrations(client, { files: [...BASE_MIGRATIONS] });
    await runMigrations(client, { files: ["00060_pool_config_v2"] });

    await expect(
      client.query(
        `INSERT INTO pool_keys (
            chain_id,
            core_address,
            pool_id,
            token0,
            token1,
            fee,
            fee_denominator,
            tick_spacing,
            pool_extension
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          1,
          "1000",
          "2000",
          "3000",
          "3001",
          "1",
          EVM_POOL_FEE_DENOMINATOR.toString(),
          null,
          "4000",
        ]
      )
    ).rejects.toThrow(/pool_keys_tick_spacing_required/);
  } finally {
    await client.close();
  }
});

test("stableswap pools allow null tick spacing", async () => {
  const client = new PGlite("memory://pool-config-v2-stableswap-tick");
  try {
    await runMigrations(client, { files: [...BASE_MIGRATIONS] });
    await runMigrations(client, { files: ["00060_pool_config_v2"] });

    const {
      rows: [{ pool_key_id }],
    } = await client.query<{ pool_key_id: bigint }>(
      `INSERT INTO pool_keys (
          chain_id,
          core_address,
          pool_id,
          token0,
          token1,
          fee,
          fee_denominator,
          tick_spacing,
          pool_extension,
          pool_config_type,
          stableswap_center_tick,
          stableswap_amplification
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING pool_key_id`,
      [
        1,
        "1000",
        "2000",
        "3000",
        "3001",
        "1",
        EVM_POOL_FEE_DENOMINATOR.toString(),
        null,
        "4000",
        "stableswap",
        0,
        10,
      ]
    );

    expect(pool_key_id).toBeDefined();
  } finally {
    await client.close();
  }
});

test("concentrated pools must keep stableswap fields null", async () => {
  const client = new PGlite("memory://pool-config-v2-concentrated-stableswap-fields");
  try {
    await runMigrations(client, { files: [...BASE_MIGRATIONS] });
    await runMigrations(client, { files: ["00060_pool_config_v2"] });

    await expect(
      client.query(
        `INSERT INTO pool_keys (
            chain_id,
            core_address,
            pool_id,
            token0,
            token1,
            fee,
            fee_denominator,
            tick_spacing,
            pool_extension,
            stableswap_center_tick,
            stableswap_amplification
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          1,
          "1000",
          "2000",
          "3000",
          "3001",
          "1",
          EVM_POOL_FEE_DENOMINATOR.toString(),
          60,
          "4000",
          0,
          5,
        ]
      )
    ).rejects.toThrow(/pool_keys_tick_spacing_required/);
  } finally {
    await client.close();
  }
});

test("stableswap pools require center tick and amplification", async () => {
  const client = new PGlite("memory://pool-config-v2-stableswap-fields");
  try {
    await runMigrations(client, { files: [...BASE_MIGRATIONS] });
    await runMigrations(client, { files: ["00060_pool_config_v2"] });

    await expect(
      client.query(
        `INSERT INTO pool_keys (
            chain_id,
            core_address,
            pool_id,
            token0,
            token1,
            fee,
            fee_denominator,
            tick_spacing,
            pool_extension,
            pool_config_type,
            stableswap_center_tick,
            stableswap_amplification
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          1,
          "1000",
          "2000",
          "3000",
          "3001",
          "1",
          EVM_POOL_FEE_DENOMINATOR.toString(),
          null,
          "4000",
          "stableswap",
          null,
          5,
        ]
      )
    ).rejects.toThrow(/pool_keys_tick_spacing_required/);

    await expect(
      client.query(
        `INSERT INTO pool_keys (
            chain_id,
            core_address,
            pool_id,
            token0,
            token1,
            fee,
            fee_denominator,
            tick_spacing,
            pool_extension,
            pool_config_type,
            stableswap_center_tick,
            stableswap_amplification
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          1,
          "1000",
          "2000",
          "3000",
          "3001",
          "1",
          EVM_POOL_FEE_DENOMINATOR.toString(),
          null,
          "4000",
          "stableswap",
          0,
          null,
        ]
      )
    ).rejects.toThrow(/pool_keys_tick_spacing_required/);
  } finally {
    await client.close();
  }
});
