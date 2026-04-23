import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations, runMigrationsThrough } from "../helpers/db.js";

const PRE_MIGRATION = 102;
const TARGET_MIGRATION =
  "00103_narrow_eth_usdc_q2_2026_realized_volatility_range";

test("sets the final realized volatility only for future periods of latest Ethereum USDC incentives campaign", async () => {
  const client = new PGlite("memory://temp");

  try {
    await runMigrationsThrough(client, PRE_MIGRATION);

    const {
      rows: [{ id: campaignId }],
    } = await client.query<{ id: number }>(
      `SELECT id
       FROM incentives.campaigns
       WHERE slug = 'eth_usdc_q2_26'`,
    );

    const now = Date.now();
    const toIso = (value: number) => new Date(value).toISOString();

    const {
      rows: [{ id: pastPeriodId }],
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
          9000,
          9001,
          $2,
          $3,
          0.2,
          1,
          0,
          NULL
       )
       RETURNING id`,
      [
        campaignId,
        toIso(now - 4 * 60 * 60 * 1000),
        toIso(now - 2 * 60 * 60 * 1000),
      ],
    );

    const {
      rows: [{ id: futurePeriodId }],
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
          9000,
          9001,
          $2,
          $3,
          0.2,
          1,
          0,
          NULL
       )
       RETURNING id`,
      [
        campaignId,
        toIso(now + 2 * 60 * 60 * 1000),
        toIso(now + 4 * 60 * 60 * 1000),
      ],
    );

    const {
      rows: [{ id: computedFuturePeriodId }],
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
          9000,
          9001,
          $2,
          $3,
          0.2,
          1,
          0,
          $4
       )
       RETURNING id`,
      [
        campaignId,
        toIso(now + 5 * 60 * 60 * 1000),
        toIso(now + 6 * 60 * 60 * 1000),
        toIso(now - 30 * 60 * 60 * 1000),
      ],
    );

    await runMigrations(client, { files: [TARGET_MIGRATION] });

    const { rows } = await client.query<{
      id: number;
      realized_volatility: number;
    }>(
      `SELECT id, realized_volatility
       FROM incentives.campaign_reward_periods
       WHERE id = ANY($1::bigint[])
       ORDER BY id`,
      [[pastPeriodId, futurePeriodId, computedFuturePeriodId]],
    );

    expect(rows).toEqual([
      { id: pastPeriodId, realized_volatility: 0.2 },
      { id: futurePeriodId, realized_volatility: 0.1 },
      { id: computedFuturePeriodId, realized_volatility: 0.2 },
    ]);
  } finally {
    await client.close();
  }
});
