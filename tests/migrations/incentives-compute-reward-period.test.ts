import { expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

test("compute reward period function is registered", async () => {
  const client = await createClient();
  try {
    const {
      rows: [{ exists }],
    } = await client.query<{ exists: boolean }>(
      `SELECT to_regprocedure('incentives.compute_reward_period(bigint)') IS NOT NULL AS exists`
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
      `SELECT incentives.compute_reward_period($1)::bigint AS rows_inserted`,
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
      `SELECT incentives.compute_reward_period($1)::bigint AS recomputed`,
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

async function seedBlocks(client: PGlite) {
  await client.query(`
    INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
    VALUES
      (1, 99, 999, '2023-12-31T23:00:00Z'),
      (1, 100, 1000, '2024-01-01T00:00:00Z'),
      (1, 101, 1001, '2024-01-01T00:30:00Z'),
      (1, 102, 1002, '2024-01-01T01:00:00Z')
  `);
}

async function seedPoolKey(client: PGlite) {
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
     ) VALUES (1, 111, 222, 10, 11, 100, 1000000, 1, 0)
     RETURNING pool_key_id`
  );

  return pool_key_id;
}

async function seedSwaps(client: PGlite, poolKeyId: number) {
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
        (1,  99, 0, 0, 6000, 7000, $1, 0, 0, 0, 1, 0, 100000),
        (1, 100, 0, 0, 6001, 7000, $1, 0, 0, 0, 1, 1, 100000),
        (1, 101, 0, 0, 6002, 7000, $1, 0, 0, 0, 1, -1, 100000)`,
    [poolKeyId]
  );
}

async function seedPositions(client: PGlite, poolKeyId: number) {
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
     ) VALUES
        (1, 99, 0, 0, 7001, 8000, $1, 2000, 1, -120, 120, 100000, 0, 0),
        (1, 99, 0, 1, 7002, 8000, $1, 3000, 2, -120, 120, 100000, 0, 0)`,
    [poolKeyId]
  );
}

async function seedCampaign(client: PGlite) {
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
        excluded_locker_salts,
        distribution_cadence,
        minimum_allocation
     ) VALUES (
        1,
        '2023-12-31T23:00:00Z',
        '2024-01-02T00:00:00Z',
        'Test Campaign',
        'test-campaign',
        555,
        '{0}',
        0.025,
        0.9975,
        1000000,
        '{}'::incentives.locker_salt_pair[],
        '1 hour',
        0
     )
     RETURNING id`
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
