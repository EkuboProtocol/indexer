import { expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  createClient,
  ensureIndexerCursor,
  runMigrations,
} from "../helpers/db.js";

const PRE_VE33_HOURLY_FEES_MIGRATIONS = [
  "00001_chain_tables",
  "00002_core_tables",
  "00011_pool_tvl",
  "00019_hourly_tables",
  "00021_last_24h_pool_stats_view",
  "00026_hourly_tables_block_time",
  "00035_update_last_24h_pool_stats_view",
  "00104_ve33_events",
] as const;

async function seedBlock(
  client: PGlite,
  chainId: number,
  blockNumber: number,
  blockTime: Date,
) {
  await ensureIndexerCursor(client, chainId);
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 0)`,
    [chainId, blockNumber, `${chainId}${blockNumber}`, blockTime],
  );
}

async function seedPool(client: PGlite, chainId: number) {
  const {
    rows: [{ pool_key_id: poolKeyId }],
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
    [chainId, "2000", "3000", "4000", "4001", "0", "1000000", 64, "5000"],
  );

  return poolKeyId.toString();
}

test("ve33 fees are backfilled and kept reorg-safe in hourly pool stats", async () => {
  const client = await createClient({
    files: [...PRE_VE33_HOURLY_FEES_MIGRATIONS],
  });

  try {
    const chainId = 11155111;
    const blockNumber = 1000;
    const blockTime = new Date();
    await seedBlock(client, chainId, blockNumber, blockTime);
    const poolKeyId = await seedPool(client, chainId);

    await client.query(
      `INSERT INTO swaps (
          chain_id,
          block_number,
          transaction_index,
          event_index,
          transaction_hash,
          emitter,
          pool_key_id,
          locker,
          delta0,
          delta1,
          sqrt_ratio_after,
          tick_after,
          liquidity_after
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        chainId,
        blockNumber,
        0,
        0,
        "6000",
        "2000",
        poolKeyId,
        "7000",
        "100",
        "-50",
        "9101112",
        15,
        "100000",
      ],
    );

    await client.query(
      `INSERT INTO ve33_pool_fees_accounted (
          chain_id,
          block_number,
          transaction_index,
          event_index,
          transaction_hash,
          emitter,
          pool_key_id,
          pool_id,
          amount0,
          amount1
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        chainId,
        blockNumber,
        0,
        1,
        "6001",
        "5000",
        poolKeyId,
        "3000",
        "5",
        "0",
      ],
    );

    await runMigrations(client, {
      files: [
        "00108_ve33_hourly_pool_fees",
        "00109_require_ve33_pool_fees_pool_key",
      ],
    });

    const { rows: backfilledRows } = await client.query<{
      token: string;
      volume: string;
      fees: string;
    }>(
      `SELECT token, volume, fees
       FROM hourly_volume_by_token
       WHERE pool_key_id = $1
       ORDER BY token`,
      [poolKeyId],
    );
    expect(backfilledRows).toEqual([
      { token: "4000", volume: "100", fees: "5" },
    ]);

    const {
      rows: [{ event_id: token1FeeEventId, block_time: insertedBlockTime }],
    } = await client.query<{ event_id: bigint; block_time: Date }>(
      `INSERT INTO ve33_pool_fees_accounted (
          chain_id,
          block_number,
          transaction_index,
          event_index,
          transaction_hash,
          emitter,
          pool_key_id,
          pool_id,
          amount0,
          amount1
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING event_id, block_time`,
      [
        chainId,
        blockNumber,
        0,
        2,
        "6002",
        "5000",
        poolKeyId,
        "3000",
        "0",
        "7",
      ],
    );
    expect(new Date(insertedBlockTime)).toEqual(blockTime);

    const { rows: insertedRows } = await client.query<{
      token: string;
      volume: string;
      fees: string;
    }>(
      `SELECT token, volume, fees
       FROM hourly_volume_by_token
       WHERE pool_key_id = $1
       ORDER BY token`,
      [poolKeyId],
    );
    expect(insertedRows).toEqual([
      { token: "4000", volume: "100", fees: "5" },
      { token: "4001", volume: "0", fees: "7" },
    ]);

    await client.exec(
      "REFRESH MATERIALIZED VIEW last_24h_pool_stats_materialized",
    );
    const { rows: apiStatsRows } = await client.query<{
      volume0_24h: string;
      fees0_24h: string;
      fees1_24h: string;
    }>(
      `SELECT volume0_24h, fees0_24h, fees1_24h
       FROM last_24h_pool_stats_materialized
       WHERE pool_key_id = $1`,
      [poolKeyId],
    );
    expect(apiStatsRows).toEqual([
      { volume0_24h: "100", fees0_24h: "5", fees1_24h: "7" },
    ]);

    await expect(
      client.query(
        `INSERT INTO ve33_pool_fees_accounted (
            chain_id,
            block_number,
            transaction_index,
            event_index,
            transaction_hash,
            emitter,
            pool_key_id,
            pool_id,
            amount0,
            amount1
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          chainId,
          blockNumber,
          0,
          3,
          "6003",
          "5000",
          null,
          "9999",
          "11",
          "0",
        ],
      ),
    ).rejects.toThrow();

    await client.query(
      `DELETE FROM ve33_pool_fees_accounted
       WHERE chain_id = $1 AND event_id = $2`,
      [chainId, token1FeeEventId],
    );

    const { rows: rowsAfterFeeDelete } = await client.query<{
      token: string;
      volume: string;
      fees: string;
    }>(
      `SELECT token, volume, fees
       FROM hourly_volume_by_token
       WHERE pool_key_id = $1
       ORDER BY token`,
      [poolKeyId],
    );
    expect(rowsAfterFeeDelete).toEqual([
      { token: "4000", volume: "100", fees: "5" },
    ]);

    await client.query(
      `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
      [chainId, blockNumber],
    );

    const {
      rows: [{ count }],
    } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM hourly_volume_by_token
       WHERE pool_key_id = $1`,
      [poolKeyId],
    );
    expect(count).toBe("0");
  } finally {
    await client.close();
  }
});
