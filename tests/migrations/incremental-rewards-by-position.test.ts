import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

async function seedCampaign(client: Client, coreAddress = 111) {
  const {
    rows: [{ id }],
  } = await client.query<{ id: number }>(
    `INSERT INTO incentives.campaigns (
        chain_id, start_time, end_time, name, slug, reward_token,
        allowed_extensions, default_fee_denominator, distribution_cadence,
        minimum_allocation, core_address
     ) VALUES (1, '2024-01-01T00:00:00Z', '2024-06-01T00:00:00Z',
               'Test', 'test', 6000, '{0}', 1000, '1 day', 0, $1)
     RETURNING id`,
    [coreAddress]
  );
  return id;
}

// idx_campaign_reward_periods_pair_period is unique over the campaign, the
// token pair and the period window, so successive periods need distinct days.
let periodDay = 0;

async function seedPeriod(client: Client, campaignId: number) {
  periodDay += 1;
  const start = `2024-01-${String(periodDay).padStart(2, "0")}T00:00:00Z`;
  const end = `2024-01-${String(periodDay + 1).padStart(2, "0")}T00:00:00Z`;

  const {
    rows: [{ id }],
  } = await client.query<{ id: number }>(
    `INSERT INTO incentives.campaign_reward_periods (
        campaign_id, token0, token1, start_time, end_time,
        realized_volatility, token0_reward_amount, token1_reward_amount
     ) VALUES ($1, 10, 11, $2, $3, 0.1, 1000, 0)
     RETURNING id`,
    [campaignId, start, end]
  );
  return id;
}

async function addReward(
  client: Client,
  periodId: number,
  locker: number,
  salt: number,
  amount: string
) {
  await client.query(
    `INSERT INTO incentives.computed_rewards
       (campaign_reward_period_id, locker, salt, reward_amount)
     VALUES ($1,$2,$3,$4)`,
    [periodId, locker, salt, amount]
  );
}

async function generateDrop(client: Client, periodId: number) {
  const {
    rows: [{ id }],
  } = await client.query<{ id: number }>(
    `INSERT INTO incentives.generated_drop (root) VALUES (123456) RETURNING id`
  );
  await client.query(
    `INSERT INTO incentives.generated_drop_reward_periods (drop_id, campaign_reward_period_id)
     VALUES ($1,$2)`,
    [id, periodId]
  );
  return id;
}

async function row(client: Client) {
  const { rows } = await client.query<{
    total_reward_amount: string;
    pending_reward_amount: string;
    source_row_count: string;
    core_address: string;
  }>(
    // source_row_count is BIGINT and comes back as a number while the NUMERIC
    // columns come back as strings; cast so the assertions stay uniform.
    `SELECT total_reward_amount, pending_reward_amount,
            source_row_count::TEXT AS source_row_count, core_address
     FROM incentives.computed_rewards_by_position
     ORDER BY campaign_id, locker, salt`
  );
  return rows;
}

async function drift(client: Client) {
  const { rows } = await client.query(
    `SELECT * FROM incentives.verify_rewards_by_position()`
  );
  return rows;
}

test("rewards aggregate forward as rows are inserted, updated and deleted", async () => {
  const client = await createClient();
  const campaign = await seedCampaign(client);
  // computed_rewards is keyed (campaign_reward_period_id, locker, salt), so a
  // group accumulates across periods rather than within one -- which is how a
  // position actually earns.
  const first = await seedPeriod(client, campaign);
  const second = await seedPeriod(client, campaign);

  await addReward(client, first, 7, 9, "500");
  await addReward(client, second, 7, 9, "250");

  // Both periods fold into one group; neither has been dropped, so all of it
  // is still pending.
  expect(await row(client)).toEqual([
    {
      total_reward_amount: "750",
      pending_reward_amount: "750",
      source_row_count: "2",
      core_address: "111",
    },
  ]);

  await client.query(
    `UPDATE incentives.computed_rewards SET reward_amount = 100
     WHERE campaign_reward_period_id = $1`,
    [second]
  );
  expect((await row(client))[0]).toMatchObject({
    total_reward_amount: "600",
    pending_reward_amount: "600",
    source_row_count: "2",
  });

  await client.query(
    `DELETE FROM incentives.computed_rewards
     WHERE campaign_reward_period_id IN ($1, $2)`,
    [first, second]
  );

  // Every underlying row is gone, so the group goes with it.
  expect(await row(client)).toEqual([]);
  expect(await drift(client)).toEqual([]);
});

test("a zero-sum group survives, because zero rewards are real rows", async () => {
  const client = await createClient();
  const campaign = await seedCampaign(client);
  const period = await seedPeriod(client, campaign);

  // 259 rows in production have reward_amount = 0 and 6 groups sum to exactly
  // zero, so the group cannot be removed on total = 0.
  await addReward(client, period, 7, 9, "0");

  expect((await row(client))[0]).toMatchObject({
    total_reward_amount: "0",
    source_row_count: "1",
  });
  expect(await drift(client)).toEqual([]);
});

test("generating a drop clears that period's pending, not the total", async () => {
  const client = await createClient();
  const campaign = await seedCampaign(client);
  const dropped = await seedPeriod(client, campaign);
  const open = await seedPeriod(client, campaign);

  await addReward(client, dropped, 7, 9, "500");
  const dropId = await generateDrop(client, dropped);

  expect((await row(client))[0]).toMatchObject({
    total_reward_amount: "500",
    pending_reward_amount: "0",
  });

  // A later period with no drop is pending; the dropped one stays settled.
  await addReward(client, open, 7, 9, "300");
  expect((await row(client))[0]).toMatchObject({
    total_reward_amount: "800",
    pending_reward_amount: "300",
  });

  // generated_drop cascades to generated_drop_reward_periods; removing it puts
  // that period back into pending.
  await client.query(`DELETE FROM incentives.generated_drop WHERE id = $1`, [
    dropId,
  ]);
  expect((await row(client))[0]).toMatchObject({
    total_reward_amount: "800",
    pending_reward_amount: "800",
  });
  expect(await drift(client)).toEqual([]);
});

test("a period cannot be attached to two drops", async () => {
  const client = await createClient();
  const campaign = await seedCampaign(client);
  const period = await seedPeriod(client, campaign);
  await addReward(client, period, 7, 9, "500");

  await generateDrop(client, period);

  // The PK (drop_id, campaign_reward_period_id) would permit this, but
  // idx_generated_drop_reward_periods_crp_id is a UNIQUE index on
  // campaign_reward_period_id alone. That is what keeps one drop per period,
  // and it is why summing over the drop join cannot double count. It is an
  // index rather than a constraint, so it does not appear in pg_constraint.
  expect(generateDrop(client, period)).rejects.toThrow(
    /idx_generated_drop_reward_periods_crp_id/
  );
});

test("core_address follows the campaign it is projected from", async () => {
  const client = await createClient();
  const campaign = await seedCampaign(client, 111);
  const period = await seedPeriod(client, campaign);
  await addReward(client, period, 7, 9, "500");

  await client.query(
    `UPDATE incentives.campaigns SET core_address = 222 WHERE id = $1`,
    [campaign]
  );

  expect((await row(client))[0]).toMatchObject({ core_address: "222" });
  expect(await drift(client)).toEqual([]);
});

test("the matview name still resolves, with the same columns", async () => {
  const client = await createClient();
  const campaign = await seedCampaign(client);
  const period = await seedPeriod(client, campaign);
  await addReward(client, period, 7, 9, "500");

  // The API selects from this name; it is now a view over the table, and must
  // not leak source_row_count.
  const { rows } = await client.query(
    `SELECT * FROM incentives.computed_rewards_by_position_materialized`
  );
  expect(Object.keys(rows[0] as object).sort()).toEqual([
    "campaign_id",
    "core_address",
    "locker",
    "pending_reward_amount",
    "salt",
    "total_reward_amount",
  ]);

  const { rows: kind } = await client.query<{ relkind: string }>(
    `SELECT relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'incentives'
       AND c.relname = 'computed_rewards_by_position_materialized'`
  );
  expect(kind[0]!.relkind).toBe("v");
});

test("rebuild reproduces exactly what the triggers maintained", async () => {
  const client = await createClient();
  const campaign = await seedCampaign(client);
  const period = await seedPeriod(client, campaign);
  await addReward(client, period, 7, 9, "500");
  await addReward(client, period, 8, 9, "0");
  await generateDrop(client, period);
  await addReward(client, period, 7, 10, "125");

  const before = await row(client);
  await client.query(`SELECT incentives.rebuild_rewards_by_position()`);

  expect(await row(client)).toEqual(before);
  expect(await drift(client)).toEqual([]);
});
