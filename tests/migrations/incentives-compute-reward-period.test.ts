import { expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

test("compute reward period function is registered", async () => {
  const client = await createClient();
  try {
    const {
      rows: [{ exists }],
    } = await client.query<{ exists: boolean }>(
      `SELECT to_regprocedure('incentives.compute_rewards_for_period_v1(bigint)') IS NOT NULL AS exists`
    );

    expect(exists).toBe(true);
  } finally {
    await client.close();
  }
});

test("compute reward period distributes rewards across lockers", async () => {
  const client = await createClient();
  try {
    await seedBlocks(client);
    const poolKeyId = await seedPoolKey(client);
    await seedSwaps(client, poolKeyId);
    await seedPositions(client, poolKeyId);
    const { campaignId, rewardPeriodId } = await seedCampaign(client);

    const {
      rows: [{ rows_inserted }],
    } = await client.query<{ rows_inserted: string }>(
      `SELECT incentives.compute_rewards_for_period_v1($1)::bigint AS rows_inserted`,
      [rewardPeriodId]
    );

    expect(Number(rows_inserted)).toBe(2);

    const { rows: rewards } = await client.query<{
      locker: string;
      salt: string;
      reward_amount: string;
    }>(
      `SELECT locker::text AS locker,
              salt::text AS salt,
              reward_amount::text AS reward_amount
       FROM incentives.computed_rewards
       WHERE campaign_reward_period_id = $1
       ORDER BY locker`,
      [rewardPeriodId]
    );

    expect(rewards).toEqual([
      { locker: "2000", salt: "1", reward_amount: "500" },
      { locker: "3000", salt: "2", reward_amount: "500" },
    ]);

    const {
      rows: [{ total }],
    } = await client.query<{ total: string }>(
      `SELECT sum(reward_amount)::text AS total
       FROM incentives.computed_rewards
       WHERE campaign_reward_period_id = $1`,
      [rewardPeriodId]
    );
    expect(total).toBe("1000");

    const {
      rows: [{ recomputed }],
    } = await client.query<{ recomputed: string }>(
      `SELECT incentives.compute_rewards_for_period_v1($1)::bigint AS recomputed`,
      [rewardPeriodId]
    );
    expect(Number(recomputed)).toBe(2);

    const {
      rows: [{ lastComputed }],
    } = await client.query<{ lastComputed: string | null }>(
      `SELECT rewards_last_computed_at::text AS lastComputed
       FROM incentives.campaign_reward_periods
       WHERE id = $1`,
      [rewardPeriodId]
    );
    expect(lastComputed).not.toBeNull();
  } finally {
    await client.close();
  }
});

test("compute reward period filters allowed lockers", async () => {
  const client = await createClient();
  try {
    await seedBlocks(client);
    const poolKeyId = await seedPoolKey(client);
    await seedSwaps(client, poolKeyId);
    await seedPositions(client, poolKeyId);
    const { rewardPeriodId } = await seedCampaign(client, {
      allowedLockers: [2000],
      slug: "allowed-lockers",
    });

    const {
      rows: [{ rows_inserted }],
    } = await client.query<{ rows_inserted: string }>(
      `SELECT incentives.compute_rewards_for_period_v1($1)::bigint AS rows_inserted`,
      [rewardPeriodId]
    );
    expect(Number(rows_inserted)).toBe(1);

    const { rows: rewards } = await client.query<{
      locker: string;
      salt: string;
      reward_amount: string;
    }>(
      `SELECT locker::text AS locker,
              salt::text AS salt,
              reward_amount::text AS reward_amount
       FROM incentives.computed_rewards
       WHERE campaign_reward_period_id = $1
       ORDER BY locker`,
      [rewardPeriodId]
    );

    expect(rewards).toEqual([
      { locker: "2000", salt: "1", reward_amount: "1000" },
    ]);
  } finally {
    await client.close();
  }
});

test("compute reward period filters campaign core address", async () => {
  const client = await createClient();
  try {
    await seedBlocks(client);
    const primaryPoolKeyId = await seedPoolKey(client);
    const secondaryPoolKeyId = await seedPoolKey(client, {
      coreAddress: 222,
      poolId: 333,
    });
    await seedSwaps(client, primaryPoolKeyId);
    await seedSwaps(client, secondaryPoolKeyId, { eventIndexOffset: 1 });
    await seedPositions(client, primaryPoolKeyId);
    await seedPositions(client, secondaryPoolKeyId, {
      eventIndexStart: 5,
      positions: [
        {
          locker: 4000,
          salt: 3,
          liquidityDelta: 150000,
          lowerBound: -120,
          upperBound: 120,
        },
      ],
    });
    const { rewardPeriodId } = await seedCampaign(client, {
      coreAddress: 222,
      slug: "core-filter",
    });

    const {
      rows: [{ rows_inserted }],
    } = await client.query<{ rows_inserted: string }>(
      `SELECT incentives.compute_rewards_for_period_v1($1)::bigint AS rows_inserted`,
      [rewardPeriodId]
    );
    expect(Number(rows_inserted)).toBe(1);

    const { rows: rewards } = await client.query<{
      locker: string;
      salt: string;
      reward_amount: string;
    }>(
      `SELECT locker::text AS locker,
              salt::text AS salt,
              reward_amount::text AS reward_amount
       FROM incentives.computed_rewards
       WHERE campaign_reward_period_id = $1
       ORDER BY locker`,
      [rewardPeriodId]
    );

    expect(rewards).toEqual([
      { locker: "4000", salt: "3", reward_amount: "1000" },
    ]);
  } finally {
    await client.close();
  }
});

test("compute pending reward periods processes outstanding rows", async () => {
  const client = await createClient();
  try {
    await seedBlocks(client);
    await client.query(`
      INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
      VALUES (1, 103, 1003, '2024-01-01T02:00:00Z', 0)
    `);
    const poolKeyId = await seedPoolKey(client);
    await seedSwaps(client, poolKeyId);
    await seedPositions(client, poolKeyId);
    const { rewardPeriodId } = await seedCampaign(client);

    const {
      rows: [{ computed_rows }],
    } = await client.query<{ computed_rows: string }>(
      `SELECT incentives.compute_pending_reward_periods()::bigint AS computed_rows`
    );
    expect(Number(computed_rows)).toBe(2);

    const {
      rows: [{ pending_count }],
    } = await client.query<{ pending_count: string }>(
      `SELECT COUNT(*)::bigint AS pending_count
       FROM incentives.pending_reward_periods
       WHERE reward_period_id = $1`,
      [rewardPeriodId]
    );
    expect(Number(pending_count)).toBe(0);

    const {
      rows: [{ lastComputed }],
    } = await client.query<{ lastComputed: string | null }>(
      `SELECT rewards_last_computed_at::text AS lastComputed
       FROM incentives.campaign_reward_periods
       WHERE id = $1`,
      [rewardPeriodId]
    );
    expect(lastComputed).not.toBeNull();
  } finally {
    await client.close();
  }
});

test("computed rewards materialized view aggregates totals and pending amounts", async () => {
  const client = await createClient();
  try {
    await seedBlocks(client);
    const poolKeyId = await seedPoolKey(client);
    await seedSwaps(client, poolKeyId);
    await seedPositions(client, poolKeyId);
    const { campaignId, rewardPeriodId } = await seedCampaign(client);

    await client.query(`SELECT incentives.compute_rewards_for_period_v1($1)`, [
      rewardPeriodId,
    ]);
    await client.query(
      `REFRESH MATERIALIZED VIEW incentives.computed_rewards_by_position_materialized`
    );

    const { rows: initialRows } = await client.query<{
      campaign_id: string;
      core_address: string;
      locker: string;
      salt: string;
      total: string;
      pending: string;
    }>(
      `SELECT campaign_id::text,
              core_address::text AS core_address,
              locker::text,
              salt::text,
              total_reward_amount::text AS total,
              pending_reward_amount::text AS pending
       FROM incentives.computed_rewards_by_position_materialized
       WHERE campaign_id = $1
       ORDER BY locker`,
      [campaignId]
    );

    expect(initialRows).toEqual([
      {
        campaign_id: campaignId.toString(),
        locker: "2000",
        pending: "500",
        salt: "1",
        total: "500",
        core_address: "111",
      },
      {
        campaign_id: campaignId.toString(),
        core_address: "111",
        locker: "3000",
        pending: "500",
        salt: "2",
        total: "500",
      },
    ]);

    const {
      rows: [{ id: dropId }],
    } = await client.query<{ id: number }>(
      `INSERT INTO incentives.generated_drop (root)
       VALUES (123456)
       RETURNING id`
    );
    await client.query(
      `INSERT INTO incentives.generated_drop_reward_periods (drop_id, campaign_reward_period_id)
       VALUES ($1, $2)`,
      [dropId, rewardPeriodId]
    );

    await client.query(
      `REFRESH MATERIALIZED VIEW incentives.computed_rewards_by_position_materialized`
    );

    const { rows: refreshedRows } = await client.query<{
      campaign_id: string;
      core_address: string;
      locker: string;
      salt: string;
      total: string;
      pending: string;
    }>(
      `SELECT campaign_id::text,
              core_address::text AS core_address,
              locker::text,
              salt::text,
              total_reward_amount::text AS total,
              pending_reward_amount::text AS pending
       FROM incentives.computed_rewards_by_position_materialized
       WHERE campaign_id = $1
       ORDER BY locker`,
      [campaignId]
    );

    expect(refreshedRows).toEqual([
      {
        campaign_id: campaignId.toString(),
        locker: "2000",
        pending: "0",
        salt: "1",
        total: "500",
        core_address: "111",
      },
      {
        campaign_id: campaignId.toString(),
        core_address: "111",
        locker: "3000",
        pending: "0",
        salt: "2",
        total: "500",
      },
    ]);
  } finally {
    await client.close();
  }
});

async function seedBlocks(client: PGlite) {
  await client.query(`
    INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
    VALUES
      (1, 99, 999, '2023-12-31T23:00:00Z', 0),
      (1, 100, 1000, '2024-01-01T00:00:00Z', 0),
      (1, 101, 1001, '2024-01-01T00:30:00Z', 0),
      (1, 102, 1002, '2024-01-01T01:00:00Z', 0)
  `);
}

type PoolKeyOptions = {
  coreAddress?: number;
  poolId?: number;
  extension?: number;
  fee?: number;
  feeDenominator?: number;
  tickSpacing?: number | null;
};

async function seedPoolKey(client: PGlite, options: PoolKeyOptions = {}) {
  const {
    coreAddress = 111,
    poolId = 222,
    extension = 0,
    fee = 100,
    feeDenominator = 1000000,
    tickSpacing = 1,
  } = options;
  const {
    rows: [{ pool_key_id }],
  } = await client.query<{ pool_key_id: number }>(
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
     ) VALUES (1, $1, $2, 10, 11, $3, $4, $5, $6)
     RETURNING pool_key_id`,
    [coreAddress, poolId, fee, feeDenominator, tickSpacing, extension]
  );

  return pool_key_id;
}

async function seedSwaps(
  client: PGlite,
  poolKeyId: number,
  options: { eventIndexOffset?: number } = {}
) {
  const { eventIndexOffset = 0 } = options;
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
     ) VALUES
        (1,  99, 0, $2, 6000, 7000, $1, 0, 0, 0, 1, 0, 100000),
        (1, 100, 0, $2, 6001, 7000, $1, 0, 0, 0, 1, 1, 100000),
        (1, 101, 0, $2, 6002, 7000, $1, 0, 0, 0, 1, -1, 100000)`,
    [poolKeyId, eventIndexOffset]
  );
}

type PositionSeed = {
  locker: number;
  salt: number;
  lowerBound?: number;
  upperBound?: number;
  liquidityDelta?: number;
  delta0?: number;
  delta1?: number;
  blockNumber?: number;
};

async function seedPositions(
  client: PGlite,
  poolKeyId: number,
  options: { positions?: PositionSeed[]; eventIndexStart?: number } = {}
) {
  const {
    positions = [
      { locker: 2000, salt: 1, liquidityDelta: 100000, lowerBound: -120, upperBound: 120 },
      { locker: 3000, salt: 2, liquidityDelta: 100000, lowerBound: -120, upperBound: 120 },
    ],
    eventIndexStart = 0,
  } = options;

  for (const [index, position] of positions.entries()) {
    const blockNumber = position.blockNumber ?? 99;
    const eventIndex = eventIndexStart + index;
    const transactionHash = 7001 + eventIndex;
    await client.query(
      `INSERT INTO position_updates (
          chain_id,
          block_number,
          transaction_index,
          event_index,
          transaction_hash,
          emitter,
          pool_key_id,
          locker,
          salt,
          lower_bound,
          upper_bound,
          liquidity_delta,
          delta0,
          delta1
       ) VALUES (
          1,
          $1,
          0,
          $2,
          $3,
          8000,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11
       )`,
      [
        blockNumber,
        eventIndex,
        transactionHash,
        poolKeyId,
        position.locker,
        position.salt,
        position.lowerBound ?? -120,
        position.upperBound ?? 120,
        position.liquidityDelta ?? 100000,
        position.delta0 ?? 0,
        position.delta1 ?? 0,
      ]
    );
  }
}

async function seedCampaign(
  client: PGlite,
  options: {
    allowedLockers?: number[] | null;
    coreAddress?: number;
    slug?: string;
  } = {}
) {
  const {
    allowedLockers = null,
    coreAddress = 111,
    slug = "test-campaign",
  } = options;
  const {
    rows: [{ id: campaignId }],
  } = await client.query<{ id: number }>(
    `INSERT INTO incentives.campaigns (
        chain_id,
        start_time,
        end_time,
        name,
        slug,
        reward_token,
        allowed_extensions,
        default_percent_step,
        default_max_coverage,
        default_fee_denominator,
        distribution_cadence,
        minimum_allocation,
        core_address,
        allowed_lockers
     ) VALUES (
        1,
        '2023-12-31T23:00:00Z',
        '2024-01-02T00:00:00Z',
        'Test Campaign',
        $1,
        555,
        '{0}',
        0.025,
        0.9975,
        1000000,
        '1 hour',
        0,
        $2,
        $3::numeric[]
     )
     RETURNING id`,
    [slug, coreAddress, allowedLockers]
  );

  const {
    rows: [{ id: rewardPeriodId }],
  } = await client.query<{ id: number }>(
    `INSERT INTO incentives.campaign_reward_periods (
        campaign_id,
        token0,
        token1,
        start_time,
        end_time,
        realized_volatility,
        token0_reward_amount,
        token1_reward_amount,
        rewards_last_computed_at
     ) VALUES (
        $1,
        10,
        11,
        '2024-01-01T00:00:00Z',
        '2024-01-01T01:00:00Z',
        0.1,
        1000,
        0,
        NULL
     )
     RETURNING id`,
    [campaignId]
  );

  return { campaignId, rewardPeriodId };
}
