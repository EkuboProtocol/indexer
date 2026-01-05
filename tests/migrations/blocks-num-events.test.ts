import { expect, test } from "bun:test";
import { createClient, runMigrations } from "../helpers/db.js";

const BASE_MIGRATIONS = ["00001_chain_tables", "00002_core_tables"] as const;

test("migration backfills block event counts and cleans up old empty blocks", async () => {
  const client = await createClient({ files: [...BASE_MIGRATIONS] });

  try {
    const chainId = 1;

    await client.query(
      `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
       VALUES ($1, $2, $3, $4, 0), ($1, $5, $6, $7, 0), ($1, $8, $9, $10, 0)`,
      [
        chainId,
        1,
        "1001",
        new Date("2024-01-01T00:00:00Z"), // should be deleted (old and empty)
        2,
        "1002",
        new Date(), // recent and empty
        3,
        "1003",
        new Date("2024-01-02T00:00:00Z"), // old but with events
      ]
    );

    const {
      rows: [{ pool_key_id: poolKeyId }],
    } = await client.query<{ pool_key_id: number }>(
      `INSERT INTO pool_keys (
         chain_id, core_address, pool_id, token0, token1, fee, fee_denominator, tick_spacing, pool_extension
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING pool_key_id`,
      [chainId, "1", "10", "2", "3", "1", "1000", 1, "0"]
    );

    await client.query(
      `INSERT INTO pool_initializations (
         chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, pool_key_id, tick, sqrt_ratio
       ) VALUES ($1, $2, 0, 0, $3, $4, $5, 1, 1)`,
      [chainId, 3, "2001", "3001", poolKeyId]
    );

    await client.query(
      `INSERT INTO position_updates (
         chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, lower_bound, upper_bound, liquidity_delta, delta0, delta1
       ) VALUES ($1, $2, 1, 0, $3, $4, $5, $6, $7, 0, 1, 0, 0, 0)`,
      [chainId, 3, "2002", "3002", poolKeyId, "4001", "5001"]
    );

    await runMigrations(client, { files: ["00087_blocks_num_events"] });

    const { rows } = await client.query<{
      block_number: number;
      num_events: string;
    }>(
      `SELECT block_number, num_events::text AS num_events
       FROM blocks
       WHERE chain_id = $1
       ORDER BY block_number`,
      [chainId]
    );

    expect(rows).toEqual([
      { block_number: 1, num_events: "0" },
      { block_number: 2, num_events: "0" },
      { block_number: 3, num_events: "3" },
    ]);

    const {
      rows: [{ deleted }],
    } = await client.query<{ deleted: number }>(
      `SELECT delete_old_empty_blocks() AS deleted`
    );

    expect(deleted).toBe(1);

    const { rows: remainingBlocks } = await client.query<{
      block_number: number;
    }>(`SELECT block_number FROM blocks ORDER BY block_number`);

    expect(remainingBlocks.map((row) => row.block_number)).toEqual([2, 3]);
  } finally {
    await client.close();
  }
});
