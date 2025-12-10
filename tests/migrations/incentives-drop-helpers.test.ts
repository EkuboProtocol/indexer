import { expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

test("pending drop cadences and drop allocations helpers", async () => {
  const client: PGlite = await createClient();
  try {
    await seedBlocks(client);
    const campaignId = await insertCampaign(client, {
      chainId: 1,
      slug: "campaign-a",
      start: "2024-01-01T00:00:00Z",
      end: "2024-01-04T00:00:00Z",
      minAllocation: 100,
      cadence: "3 days",
    });

    const periodIds = await insertRewardPeriods(client, campaignId, [
      { start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z" },
      { start: "2024-01-02T00:00:00Z", end: "2024-01-03T00:00:00Z" },
      { start: "2024-01-03T00:00:00Z", end: "2024-01-04T00:00:00Z" },
    ]);

    await insertComputedRewards(client, periodIds, {
      positionsLocker: "7000",
      tokenOwner: "9000",
      directLocker: "8000",
    });

    const nftEmitter = "8000000000000000001";
    await client.query(
      `INSERT INTO nft_locker_mappings (chain_id, nft_address, locker)
       VALUES ($1, $2, $3)
       ON CONFLICT (chain_id, nft_address) DO UPDATE SET locker = EXCLUDED.locker`,
      [1, nftEmitter, "7000"]
    );

    await insertPositionTransfers(client, {
      positionsLocker: "7000",
      tokenOwner: "9000",
      tokenId: "1001",
      nftEmitter,
    });

    const { rows: pendingRows } = await client.query<{
      slug: string;
      period_ids: number[] | string[];
      minimum_allocation: string;
    }>(
      `SELECT slug, period_ids, minimum_allocation::text AS minimum_allocation
       FROM incentives.pending_drop_cadences
       WHERE chain_id = $1
       ORDER BY slug`,
      [1]
    );

    expect(pendingRows.length).toBe(1);
    expect(pendingRows[0].slug).toBe("campaign-a");
    const normalizedPeriodIds = Array.isArray(pendingRows[0].period_ids)
      ? pendingRows[0].period_ids.map((p) => Number(p))
      : [];
    expect(normalizedPeriodIds).toEqual(periodIds);

    const periodArrayParam = `{${periodIds.join(",")}}`;
    const { rows: allocations } = await client.query<{
      recipient: string;
      amount: string;
    }>(
      `SELECT recipient, amount FROM incentives.drop_allocations($1::bigint[])`,
      [periodArrayParam]
    );

    expect(allocations.length).toBe(2);
    expect(allocations[0].recipient).toBe("9000");
    expect(allocations[0].amount).toBe("1800");
    expect(allocations[1].recipient).toBe("8000");
    expect(allocations[1].amount).toBe("400");
  } finally {
    await client.close();
  }
});

test("drop allocations uses salt transform when locker mapping enabled", async () => {
  const client: PGlite = await createClient();
  try {
    await seedBlocks(client);
    const campaignId = await insertCampaign(client, {
      chainId: 1,
      slug: "campaign-transform",
      start: "2024-01-01T00:00:00Z",
      end: "2024-01-05T00:00:00Z",
      minAllocation: 0,
      cadence: "1 day",
    });

    const [periodId] = await insertRewardPeriods(
      client,
      campaignId,
      [
        {
          start: "2024-01-01T00:00:00Z",
          end: "2024-01-03T00:00:00Z",
        },
      ]
    );

    const tokenId = (2n ** 200n + 1234n).toString();
    const saltModulo = (BigInt(tokenId) % (2n ** 192n)).toString();
    const positionsLocker = "7000";
    const nftEmitter = "8000000000000000001";
    const tokenOwner = "9000";

    const bitMod = 192;
    await client.query(
      `INSERT INTO nft_locker_mappings (chain_id, nft_address, locker, token_id_transform)
       VALUES ($1, $2, $3, jsonb_build_object('bit_mod', $4::numeric))
       ON CONFLICT (chain_id, nft_address)
           DO UPDATE SET locker = EXCLUDED.locker,
                         token_id_transform = EXCLUDED.token_id_transform`,
      [1, nftEmitter, positionsLocker, bitMod]
    );

    await client.query(
      `INSERT INTO incentives.computed_rewards (
          campaign_reward_period_id,
          locker,
          salt,
          reward_amount
       ) VALUES ($1,$2,$3,$4)`,
      [periodId, positionsLocker, saltModulo, "500"]
    );

    await insertPositionTransfers(client, {
      positionsLocker,
      tokenOwner,
      tokenId,
      nftEmitter,
    });

    const periodArrayParam = `{${periodId}}`;
    const { rows } = await client.query<{
      recipient: string;
      amount: string;
    }>(
      `SELECT recipient::text, amount::text
       FROM incentives.drop_allocations($1::bigint[])`,
      [periodArrayParam]
    );

    expect(rows.length).toBe(1);
    expect(rows[0].recipient).toBe(tokenOwner);
    expect(rows[0].amount).toBe("500");
  } finally {
    await client.close();
  }
});

test("pending reward periods view surfaces uncomputed periods", async () => {
  const client = await createClient();
  try {
    await seedBlocks(client);
    const pendingCampaignId = await insertCampaign(client, {
      chainId: 1,
      slug: "pending-campaign",
      start: "2024-01-02T00:00:00Z",
      end: "2024-01-04T00:00:00Z",
      minAllocation: 0,
      cadence: "1 day",
    });

    const [pendingRewardPeriodId] = await insertRewardPeriods(
      client,
      pendingCampaignId,
      [
        {
          start: "2024-01-02T00:00:00Z",
          end: "2024-01-03T00:00:00Z",
        },
      ],
      { markComputed: false }
    );

    const { rows } = await client.query<{
      reward_period_id: number;
    }>(
      `SELECT reward_period_id
       FROM incentives.pending_reward_periods
       WHERE campaign_id = $1`,
      [pendingCampaignId]
    );

    expect(rows.length).toBe(1);
    expect(rows[0].reward_period_id).toBe(pendingRewardPeriodId);
  } finally {
    await client.close();
  }
});

type CampaignParams = {
  chainId: number;
  slug: string;
  start: string;
  end: string;
  minAllocation: number;
  cadence: string;
};

async function seedBlocks(client: PGlite) {
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
     VALUES
       (1, 100, 1000, '2024-01-01T00:00:00Z'),
       (1, 101, 1001, '2024-01-02T00:00:00Z'),
       (1, 102, 1002, '2024-01-03T00:00:00Z'),
       (1, 103, 1003, '2024-01-04T00:00:00Z')`
  );
}

async function insertCampaign(client: PGlite, params: CampaignParams) {
  const {
    rows: [{ id }],
  } = await client.query<{ id: number | string | bigint }>(
    `INSERT INTO incentives.campaigns (
        chain_id,
        start_time,
        end_time,
        name,
        slug,
        reward_token,
        allowed_extensions,
        default_fee_denominator,
        excluded_locker_salts,
        distribution_cadence,
        minimum_allocation
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      params.chainId,
      params.start,
      params.end,
      `Campaign ${params.slug}`,
      params.slug,
      "6000",
      "{0}",
      "1000",
      "{}",
      params.cadence,
      params.minAllocation,
    ]
  );
  return Number(id);
}

type PeriodInput = {
  start: string;
  end: string;
};

async function insertRewardPeriods(
  client: PGlite,
  campaignId: number,
  periods: PeriodInput[],
  options: { markComputed?: boolean } = {}
) {
  const { markComputed = true } = options;
  const ids: number[] = [];
  for (const period of periods) {
    const {
      rows: [{ id }],
    } = await client.query<{ id: number | string | bigint }>(
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
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        campaignId,
        "10",
        "11",
        period.start,
        period.end,
        1,
        900,
        900,
        markComputed ? period.end : null,
      ]
    );
    ids.push(Number(id));
  }
  return ids;
}

async function insertComputedRewards(
  client: PGlite,
  periodIds: number[],
  addresses: {
    positionsLocker: string;
    tokenOwner: string;
    directLocker: string;
  }
) {
  const values = [
    [periodIds[0], addresses.positionsLocker, "1001", "600"],
    [periodIds[1], addresses.positionsLocker, "1001", "600"],
    [periodIds[2], addresses.positionsLocker, "1001", "600"],
    [periodIds[0], addresses.directLocker, "2002", "200"],
    [periodIds[1], addresses.directLocker, "2002", "200"],
  ];

  for (const [periodId, locker, salt, reward] of values) {
    await client.query(
      `INSERT INTO incentives.computed_rewards (
          campaign_reward_period_id,
          locker,
          salt,
          reward_amount
       ) VALUES ($1,$2,$3,$4)`,
      [periodId, locker, salt, reward]
    );
  }
}

async function insertPositionTransfers(
  client: PGlite,
  params: {
    positionsLocker: string;
    tokenOwner: string;
    tokenId: string;
    nftEmitter?: string;
  }
) {
  const emitter = params.nftEmitter ?? params.positionsLocker;
  await client.query(
    `INSERT INTO nonfungible_token_transfers (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        token_id,
        from_address,
        to_address
     ) VALUES
        (1, 100, 0, 0, 5001, $3, $2, 0, 4000),
        (1, 101, 0, 1, 5002, $3, $2, 4000, $1)`,
    [params.tokenOwner, params.tokenId, emitter]
  );
}
