import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Pool, type PoolClient } from "pg";
import { DAO } from "./dao.ts";
import type { CoreSwapped } from "./swapEvent.ts";
import type { EventKey } from "./processor.ts";

describe("Pool Balance Changes", () => {
  let pool: Pool;
  let client: PoolClient;
  let dao: DAO;

  beforeEach(async () => {
    // Skip tests if no test database is configured
    if (!process.env.PG_TEST_CONNECTION_STRING && !process.env.PG_CONNECTION_STRING) {
      return;
    }

    // Use a test database connection
    pool = new Pool({
      connectionString: process.env.PG_TEST_CONNECTION_STRING || process.env.PG_CONNECTION_STRING,
      connectionTimeoutMillis: 1000,
    });
    client = await pool.connect();
    dao = new DAO(client);
    
    // Initialize schema (this handles its own transaction)
    await dao.initializeSchema();
  });

  afterEach(async () => {
    if (client) {
      client.release();
    }
    if (pool) {
      await pool.end();
    }
  });

  it("should create pool_balance_changes table with correct structure", async () => {
    // Skip if no database configured
    if (!client) return;

    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'pool_balance_change_event'
      ORDER BY ordinal_position;
    `);

    expect(result.rows).toEqual([
      { column_name: "event_id", data_type: "bigint", is_nullable: "NO" },
      { column_name: "pool_key_hash", data_type: "numeric", is_nullable: "NO" },
      { column_name: "delta0", data_type: "numeric", is_nullable: "NO" },
      { column_name: "delta1", data_type: "numeric", is_nullable: "NO" },
    ]);
  });

  it("should insert swap events into pool_balance_changes table", async () => {
    // Skip if no database configured
    if (!client) return;

    // First create a test pool key
    await client.query(`
      INSERT INTO pool_keys (key_hash, core_address, pool_id, token0, token1, fee, tick_spacing, extension)
      VALUES (123, 456, 789, 100, 200, 3000, 60, 0);
    `);

    // Create a test block
    await client.query(`
      INSERT INTO blocks (number, hash, time)
      VALUES (1000, 999, NOW());
    `);

    const swapEvent: CoreSwapped = {
      locker: "0x1234567890123456789012345678901234567890",
      poolId: "0x0000000000000000000000000000000000000000000000000000000000000315", // 789 in hex
      delta0: 1000000n,
      delta1: -500000n,
      liquidityAfter: 2000000n,
      sqrtRatioAfter: 1500000n,
      tickAfter: 100,
    };

    const eventKey: EventKey = {
      blockNumber: 1000,
      transactionIndex: 1,
      eventIndex: 0,
      emitter: "0x00000000000000000000000000000000000001c8", // 456 in hex
      transactionHash: "0xabcdef",
    };

    await dao.beginTransaction();
    await dao.insertSwappedEvent(swapEvent, eventKey);
    await dao.commitTransaction();

    // Verify the swap was inserted into both tables
    const swapResult = await client.query("SELECT * FROM swaps");
    expect(swapResult.rows).toHaveLength(1);

    const balanceChangeResult = await client.query("SELECT * FROM pool_balance_change_event");
    expect(balanceChangeResult.rows).toHaveLength(1);
    expect(balanceChangeResult.rows[0]).toMatchObject({
      pool_key_hash: "123",
      delta0: "1000000",
      delta1: "-500000",
    });

    // Verify the swap table references the pool_balance_change_event row
    const swapRow = swapResult.rows[0];
    expect(swapRow.pool_balance_change_id).toBe(swapRow.event_id);
  });

  it("should determine event types through joins to specific event tables", async () => {
    // Skip if no database configured
    if (!client) return;

    // This test verifies that event types can be determined by joining pool_balance_change_event
    // with the specific event tables (swaps, position_updates, etc.)
    
    await client.query(`
      INSERT INTO pool_keys (key_hash, core_address, pool_id, token0, token1, fee, tick_spacing, extension)
      VALUES (123, 456, 789, 100, 200, 3000, 60, 0);
    `);

    await client.query(`
      INSERT INTO blocks (number, hash, time)
      VALUES (1000, 999, NOW());
    `);

    // Insert a few different event types manually
    const eventId1 = 1000 * 4294967296 + 1 * 65536 + 0;
    const eventId2 = 1000 * 4294967296 + 1 * 65536 + 1;

    // Insert event_keys
    await client.query(`
      INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash, emitter)
      VALUES (1000, 1, 0, '0xabcdef', 456), (1000, 1, 1, '0xabcdef', 456);
    `);

    // Insert pool_balance_change_event
    await client.query(`
      INSERT INTO pool_balance_change_event (event_id, pool_key_hash, delta0, delta1)
      VALUES ($1, 123, 1000, -500), ($2, 123, 2000, -1000);
    `, [eventId1, eventId2]);

    // Insert a swap event that references the first pool_balance_change_event row
    await client.query(`
      INSERT INTO swaps (event_id, locker, pool_key_hash, sqrt_ratio_after, tick_after, liquidity_after, pool_balance_change_id)
      VALUES ($1, 999, 123, 1500000, 100, 2000000, $1);
    `, [eventId1]);

    // Insert a position_updates event that references the second pool_balance_change_event row
    await client.query(`
      INSERT INTO position_updates (event_id, locker, pool_key_hash, salt, lower_bound, upper_bound, liquidity_delta, pool_balance_change_id)
      VALUES ($1, 888, 123, 777, -100, 100, 5000, $1);
    `, [eventId2]);

    // Query to determine event types through joins
    const result = await client.query(`
      SELECT 
        pbc.event_id,
        CASE 
          WHEN s.event_id IS NOT NULL THEN 'swap'
          WHEN pu.event_id IS NOT NULL THEN 'position_update'
          WHEN pfc.event_id IS NOT NULL THEN 'position_fees_collected'
          WHEN fa.event_id IS NOT NULL THEN 'fees_accumulated'
          WHEN tpw.event_id IS NOT NULL THEN 'twamm_proceeds_withdrawn'
          ELSE 'unknown'
        END as event_type
      FROM pool_balance_change_event pbc
      LEFT JOIN swaps s ON pbc.event_id = s.event_id
      LEFT JOIN position_updates pu ON pbc.event_id = pu.event_id
      LEFT JOIN position_fees_collected pfc ON pbc.event_id = pfc.event_id
      LEFT JOIN fees_accumulated fa ON pbc.event_id = fa.event_id
      LEFT JOIN twamm_proceeds_withdrawals tpw ON pbc.event_id = tpw.event_id
      ORDER BY pbc.event_id;
    `);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].event_type).toBe('swap');
    expect(result.rows[1].event_type).toBe('position_update');
  });
});
