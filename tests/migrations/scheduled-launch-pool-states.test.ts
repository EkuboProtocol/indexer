import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

let client: PGlite;

beforeAll(async () => {
  client = await createClient();
});

afterAll(async () => {
  await client.close();
});

const T0 = 1_800_000_000;
const SUPPLY = 10n ** 27n;
// token < quote token, so the launch token is token0
const TOKEN = 3000;
const QUOTE = 4000;

async function seedBlock(chainId: number, blockNumber: number) {
  await ensureIndexerCursor(client, chainId);
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, TO_TIMESTAMP($4), 0)`,
    [chainId, blockNumber, `${chainId}${blockNumber}`, T0 + blockNumber],
  );
}

async function seedPool(
  chainId: number,
  poolId: string,
  { registered }: { registered: boolean },
) {
  const {
    rows: [{ pool_key_id }],
  } = await client.query<{ pool_key_id: string }>(
    `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
                            fee_denominator, tick_spacing, pool_extension, pool_config,
                            pool_config_type)
     VALUES ($1, 1000, $2, $3, $4, 0, 18446744073709551616, 100, 5000, 0, 'concentrated')
     RETURNING pool_key_id`,
    [chainId, poolId, TOKEN, QUOTE],
  );
  await client.query(
    `INSERT INTO pool_states (pool_key_id, sqrt_ratio, tick, liquidity, last_event_id)
     VALUES ($1, 100, 0, 0, compute_event_id(1, 0, 0))`,
    [pool_key_id],
  );
  if (registered) {
    await client.query(
      `INSERT INTO scheduled_launch_pool_keys (pool_key_id) VALUES ($1)`,
      [pool_key_id],
    );
  }
  return pool_key_id;
}

type At = {
  chainId: number;
  poolKeyId: string;
  blockNumber: number;
  eventIndex: number;
};

const COLUMNS = `(chain_id, block_number, transaction_index, event_index, transaction_hash, emitter`;

async function launchCreated(
  { chainId, poolKeyId, blockNumber, eventIndex }: At,
  { token = TOKEN, quote = QUOTE }: { token?: number; quote?: number } = {},
) {
  await client.query(
    `INSERT INTO scheduled_launch_created ${COLUMNS},
       pool_key_id, pool_id, token, owner, quote_token, name, symbol, decimals, total_supply,
       start_time, end_time, target_tick, upper_tick, tick_spacing, initial_fee, final_fee,
       migration_tick_lower, migration_tick_upper)
     VALUES ($1, $2, 0, $3, 1, 5000, $4, 0, $5, 77, $6, 'Launch', 'LNCH', 18, $7,
             $8, $9, -276300, -207200, 100, 4611686018427387904, 36028797018963968,
             -300000, -200000)`,
    [
      chainId,
      blockNumber,
      eventIndex,
      poolKeyId,
      token,
      quote,
      SUPPLY.toString(),
      T0 + 100,
      T0 + 86_500,
    ],
  );
}

async function launchAdvanced(
  { chainId, poolKeyId, blockNumber, eventIndex }: At,
  deployed: bigint,
  reserve0: bigint,
  reserve1: bigint,
  complete = false,
) {
  await client.query(
    `INSERT INTO scheduled_launch_advanced ${COLUMNS},
       pool_key_id, pool_id, deployed, reserve0, reserve1, complete)
     VALUES ($1, $2, 0, $3, 1, 5000, $4, 0, $5, $6, $7, $8)`,
    [
      chainId,
      blockNumber,
      eventIndex,
      poolKeyId,
      deployed.toString(),
      reserve0.toString(),
      reserve1.toString(),
      complete,
    ],
  );
}

type Row = {
  is_scheduled_launch_pool: boolean;
  token_is_token1: boolean | null;
  total_supply: string | null;
  start_time: string | null;
  end_time: string | null;
  target_tick: number | null;
  upper_tick: number | null;
  tick_spacing: number | null;
  initial_fee: string | null;
  final_fee: string | null;
  deployed: string | null;
  reserve0: string | null;
  reserve1: string | null;
  complete: boolean | null;
  last_event_id: string;
};

async function view(poolKeyId: string): Promise<Row> {
  const {
    rows: [row],
  } = await client.query<Row>(
    `SELECT is_scheduled_launch_pool,
            scheduled_launch_token_is_token1 AS token_is_token1,
            scheduled_launch_total_supply::text AS total_supply,
            scheduled_launch_start_time::text AS start_time,
            scheduled_launch_end_time::text AS end_time,
            scheduled_launch_target_tick AS target_tick,
            scheduled_launch_upper_tick AS upper_tick,
            scheduled_launch_tick_spacing AS tick_spacing,
            scheduled_launch_initial_fee::text AS initial_fee,
            scheduled_launch_final_fee::text AS final_fee,
            scheduled_launch_deployed::text AS deployed,
            scheduled_launch_reserve0::text AS reserve0,
            scheduled_launch_reserve1::text AS reserve1,
            scheduled_launch_complete AS complete,
            last_event_id::text
     FROM all_pool_states_view
     WHERE pool_key_id = $1`,
    [poolKeyId],
  );
  return row!;
}

async function state(poolKeyId: string) {
  const { rows } = await client.query<{
    deployed: string;
    reserve0: string;
    reserve1: string;
    complete: boolean;
    last_advanced_event_id: string | null;
    last_event_id: string;
  }>(
    `SELECT deployed::text, reserve0::text, reserve1::text, complete,
            last_advanced_event_id::text, last_event_id::text
     FROM scheduled_launch_pool_states WHERE pool_key_id = $1`,
    [poolKeyId],
  );
  return rows[0] ?? null;
}

async function eventId(blockNumber: number, eventIndex: number) {
  const {
    rows: [{ id }],
  } = await client.query<{ id: string }>(
    `SELECT compute_event_id($1, 0, $2)::text AS id`,
    [blockNumber, eventIndex],
  );
  return id;
}

async function deleteBlock(chainId: number, blockNumber: number) {
  await client.query(
    `DELETE FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [chainId, blockNumber],
  );
}

test("a registered pool is flagged before its LaunchCreated, with no launch columns", async () => {
  const chainId = 101;
  const poolKeyId = await seedPool(chainId, "1", { registered: true });
  const row = await view(poolKeyId);
  expect(row.is_scheduled_launch_pool).toBe(true);
  expect(row.total_supply).toBeNull();
  expect(row.deployed).toBeNull();

  const other = await seedPool(chainId, "2", { registered: false });
  expect((await view(other)).is_scheduled_launch_pool).toBe(false);
});

test("state follows LaunchCreated and the latest LaunchAdvanced, and a reorg recomputes it exactly", async () => {
  const chainId = 102;
  const poolKeyId = await seedPool(chainId, "1", { registered: false });
  const at = (blockNumber: number, eventIndex = 1) => ({
    chainId,
    poolKeyId,
    blockNumber,
    eventIndex,
  });
  for (const b of [10, 20, 30]) await seedBlock(chainId, b);

  // creation: the whole supply is saved on the launch token's side
  await launchCreated(at(10));
  const created = await view(poolKeyId);
  expect(created).toEqual({
    is_scheduled_launch_pool: true,
    token_is_token1: false,
    total_supply: SUPPLY.toString(),
    start_time: String(T0 + 100),
    end_time: String(T0 + 86_500),
    target_tick: -276300,
    upper_tick: -207200,
    tick_spacing: 100,
    initial_fee: "4611686018427387904",
    final_fee: "36028797018963968",
    deployed: "0",
    reserve0: SUPPLY.toString(),
    reserve1: "0",
    complete: false,
    last_event_id: await eventId(10, 1),
  });

  await launchAdvanced(at(20), 100n, SUPPLY - 100n, 7n);
  // a swap in the same block: advance first, then the core swap, then
  // LaunchSwapped, which does not change the state
  await launchAdvanced(at(20, 5), 150n, SUPPLY - 150n, 9n);
  await client.query(
    `INSERT INTO scheduled_launch_swapped ${COLUMNS},
       pool_key_id, pool_id, locker, delta0, delta1, fee_amount, fee_is_token1)
     VALUES ($1, 20, 0, 7, 1, 5000, $2, 0, 99, -5, 10, 1, true)`,
    [chainId, poolKeyId],
  );
  expect(await state(poolKeyId)).toEqual({
    deployed: "150",
    reserve0: (SUPPLY - 150n).toString(),
    reserve1: "9",
    complete: false,
    last_advanced_event_id: await eventId(20, 5),
    last_event_id: await eventId(20, 5),
  });
  expect((await view(poolKeyId)).last_event_id).toBe(await eventId(20, 5));

  await launchAdvanced(at(30), SUPPLY, 0n, 0n, true);
  const finished = await view(poolKeyId);
  expect([finished.deployed, finished.reserve0, finished.complete]).toEqual([
    SUPPLY.toString(),
    "0",
    true,
  ]);
  expect(finished.last_event_id).toBe(await eventId(30, 1));

  // reorg out the finishing block: back to the latest advance before it
  await deleteBlock(chainId, 30);
  expect(await state(poolKeyId)).toEqual({
    deployed: "150",
    reserve0: (SUPPLY - 150n).toString(),
    reserve1: "9",
    complete: false,
    last_advanced_event_id: await eventId(20, 5),
    last_event_id: await eventId(20, 5),
  });
  expect((await view(poolKeyId)).last_event_id).toBe(await eventId(20, 5));

  // and out the advances: back to the creation state
  await deleteBlock(chainId, 20);
  expect(await state(poolKeyId)).toEqual({
    deployed: "0",
    reserve0: SUPPLY.toString(),
    reserve1: "0",
    complete: false,
    last_advanced_event_id: null,
    last_event_id: await eventId(10, 1),
  });
  const { rows: swaps } = await client.query(
    `SELECT 1 FROM scheduled_launch_swapped WHERE pool_key_id = $1`,
    [poolKeyId],
  );
  expect(swaps).toHaveLength(0);

  // and out the creation: no launch state, and last_event_id falls back to
  // the pool's own
  await deleteBlock(chainId, 10);
  expect(await state(poolKeyId)).toBeNull();
  const gone = await view(poolKeyId);
  expect(gone.is_scheduled_launch_pool).toBe(false);
  expect(gone.deployed).toBeNull();
  expect(gone.last_event_id).toBe(await eventId(1, 0));
});

test("a launch token above its quote token is token1 and holds the supply as reserve1", async () => {
  const chainId = 103;
  const poolKeyId = await seedPool(chainId, "1", { registered: true });
  await seedBlock(chainId, 10);
  await launchCreated(
    { chainId, poolKeyId, blockNumber: 10, eventIndex: 0 },
    { token: 9000, quote: 4000 },
  );
  const row = await view(poolKeyId);
  expect([row.token_is_token1, row.reserve0, row.reserve1]).toEqual([
    true,
    "0",
    SUPPLY.toString(),
  ]);
});

test("an advance in the same transaction as an earlier event still wins by event order", async () => {
  const chainId = 104;
  const poolKeyId = await seedPool(chainId, "1", { registered: true });
  await seedBlock(chainId, 10);
  await launchCreated({ chainId, poolKeyId, blockNumber: 10, eventIndex: 0 });
  // inserted out of order: the later advance first
  await launchAdvanced(
    { chainId, poolKeyId, blockNumber: 10, eventIndex: 9 },
    20n,
    1n,
    2n,
  );
  await launchAdvanced(
    { chainId, poolKeyId, blockNumber: 10, eventIndex: 4 },
    10n,
    3n,
    4n,
  );
  expect((await state(poolKeyId))!.deployed).toBe("20");
});

test("events for an unknown pool are kept with a NULL pool_key_id and make no state", async () => {
  const chainId = 105;
  await seedBlock(chainId, 10);
  await client.query(
    `INSERT INTO scheduled_launch_advanced ${COLUMNS},
       pool_key_id, pool_id, deployed, reserve0, reserve1, complete)
     VALUES ($1, 10, 0, 0, 1, 5000, NULL, 123, 1, 2, 3, false)`,
    [chainId],
  );
  const { rows } = await client.query(
    `SELECT 1 FROM scheduled_launch_pool_states s
     JOIN pool_keys pk USING (pool_key_id) WHERE pk.chain_id = $1`,
    [chainId],
  );
  expect(rows).toHaveLength(0);
});

test("launch_creators and scheduled_launch_terminal_pools follow their events through a reorg", async () => {
  const chainId = 106;
  const launch = await seedPool(chainId, "1", { registered: true });
  const terminal = await seedPool(chainId, "2", { registered: false });
  for (const b of [10, 20, 30]) await seedBlock(chainId, b);

  await client.query(
    `INSERT INTO launch_created_by ${COLUMNS}, pool_key_id, launch_id, creator)
     VALUES ($1, 10, 0, 2, 1, 6000, $2, 1, 4242)`,
    [chainId, launch],
  );
  for (const [block, liquidity] of [
    [20, 100],
    [30, 5],
  ]) {
    await client.query(
      `INSERT INTO launch_liquidity_locked ${COLUMNS},
         pool_key_id, launch_id, terminal_pool_key_id, terminal_pool_id, liquidity)
       VALUES ($1, $2, 0, 0, 1, 7000, $3, 1, $4, 2, $5)`,
      [chainId, block, launch, terminal, liquidity],
    );
  }

  const creators = async () =>
    (
      await client.query<{ creator: string }>(
        `SELECT creator::text FROM launch_creators WHERE pool_key_id = $1`,
        [launch],
      )
    ).rows;
  const terminals = async () =>
    (
      await client.query<{
        terminal_pool_key_id: string;
        locked_liquidity: string;
      }>(
        `SELECT terminal_pool_key_id::text, locked_liquidity::text
         FROM scheduled_launch_terminal_pools WHERE pool_key_id = $1`,
        [launch],
      )
    ).rows;

  expect(await creators()).toEqual([{ creator: "4242" }]);
  expect(await terminals()).toEqual([
    { terminal_pool_key_id: String(terminal), locked_liquidity: "105" },
  ]);

  await deleteBlock(chainId, 30);
  expect(await terminals()).toEqual([
    { terminal_pool_key_id: String(terminal), locked_liquidity: "100" },
  ]);
  await deleteBlock(chainId, 20);
  await deleteBlock(chainId, 10);
  expect(await terminals()).toEqual([]);
  expect(await creators()).toEqual([]);
});

test("launch event tables reject updates", async () => {
  const chainId = 107;
  const poolKeyId = await seedPool(chainId, "1", { registered: true });
  await seedBlock(chainId, 10);
  await launchCreated({ chainId, poolKeyId, blockNumber: 10, eventIndex: 0 });
  await expect(
    client.query(
      `UPDATE scheduled_launch_created SET name = 'x' WHERE pool_key_id = $1`,
      [poolKeyId],
    ),
  ).rejects.toThrow();
});
