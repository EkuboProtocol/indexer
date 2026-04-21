import path from "node:path";
import { promises as fs } from "node:fs";
import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../helpers/db.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");
const PRE_MIGRATION = "00102_set_eth_usdc_q2_2026_realized_volatility";
const TARGET_MIGRATION =
  "00103_narrow_eth_usdc_q2_2026_realized_volatility_range";

test("narrows realized volatility only for future periods of latest Ethereum USDC incentives campaign", async () => {
  const client = new PGlite("memory://temp");

  try {
    const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
    const migrations = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    await runMigrations(client, {
      files: migrations.filter((name) => name <= PRE_MIGRATION),
    });

    const {
      rows: [{ id: campaignId }],
    } = await client.query<{ id: number }>(
      `SELECT id
       FROM incentives.campaigns
       WHERE chain_id = 1
         AND name = 'Ethereum USDC Incentives'
       ORDER BY start_time DESC
       LIMIT 1`
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
      [campaignId, toIso(now - 4 * 60 * 60 * 1000), toIso(now - 2 * 60 * 60 * 1000)]
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
      [campaignId, toIso(now + 2 * 60 * 60 * 1000), toIso(now + 4 * 60 * 60 * 1000)]
    );

    await runMigrations(client, { files: [TARGET_MIGRATION] });

    const {
      rows: [{ realized_volatility: pastVolatility }],
    } = await client.query<{ realized_volatility: number }>(
      `SELECT realized_volatility
       FROM incentives.campaign_reward_periods
       WHERE id = $1`,
      [pastPeriodId]
    );

    const {
      rows: [{ realized_volatility: futureVolatility }],
    } = await client.query<{ realized_volatility: number }>(
      `SELECT realized_volatility
       FROM incentives.campaign_reward_periods
       WHERE id = $1`,
      [futurePeriodId]
    );

    expect(pastVolatility).toBeCloseTo(0.2, 12);
    expect(futureVolatility).toBeCloseTo(0.1, 12);
  } finally {
    await client.close();
  }
});
