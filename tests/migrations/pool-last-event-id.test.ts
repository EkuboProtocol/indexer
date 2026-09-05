import { expect, test } from "bun:test";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

async function seedPool(client: Client, chainId: number, coreAddress: string) {
  await ensureIndexerCursor(client, chainId);
  const {
    rows: [{ pool_key_id }],
  } = await client.query<{ pool_key_id: string }>(
    `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
                            fee_denominator, tick_spacing, pool_extension)
     VALUES ($1, $2, $3, 4000, 4001, 100, 1000000, 60, 0)
     RETURNING pool_key_id`,
    [chainId, coreAddress, String(chainId * 10)]
  );
  return Number(pool_key_id);
}

async function setPoolState(client: Client, poolKeyId: number, lastEventId: number) {
  await client.query(
    `INSERT INTO pool_states (pool_key_id, sqrt_ratio, liquidity, tick, last_event_id)
     VALUES ($1, 1, 0, 0, $2)
     ON CONFLICT (pool_key_id) DO UPDATE SET last_event_id = EXCLUDED.last_event_id`,
    [poolKeyId, lastEventId]
  );
}

async function stored(client: Client, poolKeyId: number) {
  const { rows } = await client.query<{ last_event_id: string | null }>(
    `SELECT last_event_id::text FROM pool_last_event_id WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  return rows[0]?.last_event_id ?? null;
}

async function viewed(client: Client, poolKeyId: number) {
  const { rows } = await client.query<{ last_event_id: string | null }>(
    `SELECT last_event_id::text FROM all_pool_states_view WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  return rows[0]?.last_event_id ?? null;
}

test("the stored value is the GREATEST over the five state tables, and the view reads it", async () => {
  const client = await createClient();
  const pool = await seedPool(client, 7, "2000");

  // No pool_states row yet: not in the view, not in the table.
  expect(await stored(client, pool)).toBeNull();
  expect(await viewed(client, pool)).toBeNull();

  await setPoolState(client, pool, 100);
  expect(await stored(client, pool)).toBe("100");
  expect(await viewed(client, pool)).toBe("100");

  // A later twamm event raises it.
  await client.query(
    `INSERT INTO twamm_pool_states (pool_key_id, token0_sale_rate, token1_sale_rate,
                                    last_virtual_execution_time,
                                    last_virtual_order_execution_event_id, last_event_id)
     VALUES ($1, 0, 0, '2024-01-01T00:00:00Z', 150, 150)`,
    [pool]
  );
  expect(await stored(client, pool)).toBe("150");
  expect(await viewed(client, pool)).toBe("150");

  // A core event beyond that raises it again; one below it does not lower it.
  await setPoolState(client, pool, 200);
  expect(await stored(client, pool)).toBe("200");
  await setPoolState(client, pool, 120);
  expect(await stored(client, pool)).toBe("150");
  expect(await viewed(client, pool)).toBe("150");
});

test("a reorg that removes the newest state lowers the stored value exactly", async () => {
  const client = await createClient();
  const pool = await seedPool(client, 7, "2000");
  await setPoolState(client, pool, 100);
  await client.query(
    `INSERT INTO limit_order_pool_states (pool_key_id, last_event_id) VALUES ($1, 300)`,
    [pool]
  );
  expect(await stored(client, pool)).toBe("300");

  // It is recomputed from the sources, not tracked as a running max, so
  // deleting the row that supplied the max drops it back.
  await client.query(`DELETE FROM limit_order_pool_states WHERE pool_key_id = $1`, [pool]);
  expect(await stored(client, pool)).toBe("100");
  expect(await viewed(client, pool)).toBe("100");

  // Losing pool_states removes the pool from both, matching the view's inner join.
  await client.query(`DELETE FROM pool_states WHERE pool_key_id = $1`, [pool]);
  expect(await stored(client, pool)).toBeNull();
  expect(await viewed(client, pool)).toBeNull();
});

async function rowVersion(client: Client, poolKeyId: number) {
  const { rows } = await client.query<{ xmin: string }>(
    `SELECT xmin::text FROM pool_last_event_id WHERE pool_key_id = $1`,
    [poolKeyId]
  );
  return rows[0]!.xmin;
}

test("state rewrites that do not move last_event_id leave the stored row untouched", async () => {
  const client = await createClient();
  const pool = await seedPool(client, 7, "2000");
  await setPoolState(client, pool, 100);
  const before = await rowVersion(client, pool);

  // Other columns only: the trigger is not even a candidate.
  await client.query(`UPDATE pool_states SET liquidity = 5, tick = 3 WHERE pool_key_id = $1`, [pool]);
  expect(await rowVersion(client, pool)).toBe(before);

  // last_event_id in the SET list but unchanged -- what every state recompute
  // function does on every call. The WHEN clause keeps this from firing.
  await client.query(
    `UPDATE pool_states SET liquidity = 6, last_event_id = last_event_id WHERE pool_key_id = $1`,
    [pool]
  );
  expect(await rowVersion(client, pool)).toBe(before);

  // And a real move does rewrite it.
  await setPoolState(client, pool, 101);
  expect(await rowVersion(client, pool)).not.toBe(before);
  expect(await stored(client, pool)).toBe("101");
});

test("the driving index and the denormalised key columns are in place", async () => {
  const client = await createClient();
  const pool = await seedPool(client, 7, "2000");
  await setPoolState(client, pool, 100);

  const { rows: idx } = await client.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'pool_last_event_id'
       AND indexdef LIKE '%(chain_id, core_address, last_event_id)%'`
  );
  expect(idx).toHaveLength(1);

  const { rows } = await client.query<{ chain_id: string; core_address: string }>(
    `SELECT chain_id::text, core_address::text FROM pool_last_event_id WHERE pool_key_id = $1`,
    [pool]
  );
  expect(rows[0]).toEqual({ chain_id: "7", core_address: "2000" });

  // The view's column set is unchanged: same names, same order.
  const { rows: cols } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'all_pool_states_view' ORDER BY ordinal_position`
  );
  const names = cols.map((c) => c.column_name);
  expect(names.slice(0, 17)).toEqual([
    "pool_key_id", "chain_id", "core_address", "token0", "token1", "fee", "tick_spacing",
    "pool_extension", "pool_config", "pool_config_type", "stableswap_center_tick",
    "stableswap_amplification", "sqrt_ratio", "liquidity", "tick", "last_event_id", "ticks",
  ]);
});
