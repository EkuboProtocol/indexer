import "../src/config";
import postgres, { type Sql } from "postgres";

type LegacyCampaign = {
  id: bigint;
  start_time: Date;
  end_time: Date | null;
  name: string;
  slug: string;
  reward_token: string;
  allowed_extensions: string[] | null;
  default_percent_step: number;
  default_max_coverage: number;
  default_fee_denominator: string;
  excluded_locker_salts_literal: string | null;
  distribution_cadence: string;
  minimum_allocation: string;
};

type LegacyCampaignRewardPeriod = {
  id: bigint;
  campaign_id: bigint;
  token0: string;
  token1: string;
  start_time: Date;
  end_time: Date;
  realized_volatility: number;
  token0_reward_amount: string;
  token1_reward_amount: string;
  rewards_last_computed_at: Date | null;
  percent_step: number | null;
  max_coverage: number | null;
  fee_denominator: string | null;
};

type LegacyGeneratedDrop = {
  id: bigint;
  root: string;
  generated_at: Date | null;
};

type LegacyGeneratedDropRewardPeriod = {
  drop_id: bigint;
  campaign_reward_period_id: bigint;
};

type LegacyGeneratedDropProof = {
  drop_id: bigint;
  id: number;
  address: string;
  amount: string;
  proof: string[] | null;
};

type LegacyDeployedAirdropContract = {
  address: string;
  token: string;
  drop_id: bigint;
};

type LegacyRewardsComputedAt = {
  campaign_reward_period_id: bigint;
  locker: string;
  salt: string;
  reward_amount: string;
};

type ChainSource = {
  chainId: bigint;
  connectionString: string;
};

const LEGACY_ARG = "--chain";

function parseChainSources(argv: string[]): ChainSource[] {
  const sources: ChainSource[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === LEGACY_ARG || arg === "-c") {
      const chainIdToken = argv[++i];
      const connectionString = argv[++i];
      if (!chainIdToken || !connectionString) {
        throw new Error(
          "Each --chain flag must be followed by a chain id and a connection string"
        );
      }

      sources.push({
        chainId: BigInt(chainIdToken),
        connectionString,
      });
      continue;
    }

    if (arg.startsWith(`${LEGACY_ARG}=`)) {
      throw new Error(
        `Invalid ${LEGACY_ARG} argument. Use '--chain <chainId> <connectionString>'`
      );
    }
  }

  return sources;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds.toFixed(1)}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes - hours * 60;
  return `${hours}h ${remainingMinutes}m ${remainingSeconds.toFixed(1)}s`;
}

async function withStepProgress<T>(
  label: string,
  executor: () => Promise<T>
): Promise<T> {
  console.log(`${label}...`);
  const start = Date.now();
  try {
    const result = await executor();
    console.log(`${label} completed in ${formatDuration(Date.now() - start)}`);
    return result;
  } catch (error) {
    console.error(
      `${label} failed after ${formatDuration(Date.now() - start)}`
    );
    throw error;
  }
}

async function fetchAllLegacyData(sql: Sql<{ bigint: bigint }>) {
  const [
    campaigns,
    generatedDrops,
    generatedDropRewardPeriods,
    generatedDropProofs,
    deployedContracts,
    rewardsComputedAt,
    campaignRewardPeriods,
  ] = await sql.begin((sql) => [
    sql<LegacyCampaign[]>`
      SELECT
        id,
        start_time,
        end_time,
        name,
        slug,
        reward_token,
        allowed_extensions,
        default_percent_step,
        default_max_coverage,
        default_fee_denominator,
        excluded_locker_salts::text AS excluded_locker_salts_literal,
        distribution_cadence,
        minimum_allocation
      FROM incentives.campaigns
      ORDER BY id;
    `,
    sql<LegacyGeneratedDrop[]>`
      SELECT id, root, generated_at
      FROM incentives.generated_drop
      ORDER BY id;
    `,
    sql<LegacyGeneratedDropRewardPeriod[]>`
      SELECT drop_id, campaign_reward_period_id
      FROM incentives.generated_drop_reward_periods
      ORDER BY drop_id, campaign_reward_period_id;
    `,
    sql<LegacyGeneratedDropProof[]>`
      SELECT drop_id::int8, id, address, amount, proof
      FROM incentives.generated_drop_proof
      ORDER BY drop_id, id;
    `,
    sql<LegacyDeployedAirdropContract[]>`
      SELECT address, token, drop_id
      FROM incentives.deployed_airdrop_contracts
      ORDER BY address;
    `,
    sql<LegacyRewardsComputedAt[]>`
      SELECT campaign_reward_period_id, locker, salt, reward_amount
      FROM incentives.computed_rewards
      ORDER BY campaign_reward_period_id, locker, salt;
    `,
    sql<LegacyCampaignRewardPeriod[]>`
      SELECT
        id,
        campaign_id::int8,
        token0,
        token1,
        start_time,
        end_time,
        realized_volatility,
        token0_reward_amount,
        token1_reward_amount,
        rewards_last_computed_at,
        percent_step,
        max_coverage,
        fee_denominator
      FROM incentives.campaign_reward_periods;
    `,
  ]);

  return {
    campaigns,
    generatedDrops,
    generatedDropRewardPeriods,
    generatedDropProofs,
    deployedContracts,
    rewardsComputedAt,
    campaignRewardPeriods,
  };
}

async function importCampaigns({
  sql,
  chainId,
  campaigns,
}: {
  sql: Sql<{ bigint: bigint }>;
  chainId: bigint;
  campaigns: LegacyCampaign[];
}) {
  const map = new Map<bigint, bigint>();

  for (const campaign of campaigns) {
    const [inserted] = await sql<{ id: bigint }[]>`
      INSERT INTO incentives.campaigns (
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
      )
      VALUES (
        ${chainId},
        ${campaign.start_time},
        ${campaign.end_time},
        ${campaign.name},
        ${campaign.slug},
        ${campaign.reward_token},
        ${campaign.allowed_extensions ?? "{}"},
        ${campaign.default_percent_step},
        ${campaign.default_max_coverage},
        ${campaign.default_fee_denominator},
        ${campaign.excluded_locker_salts_literal ?? "{}"},
        ${campaign.distribution_cadence},
        ${campaign.minimum_allocation}
      )
      RETURNING id;
    `;
    map.set(campaign.id, inserted.id);
  }

  return map;
}

async function importCampaignRewardPeriods({
  sql,
  rewardPeriods,
  campaignIdMap,
}: {
  sql: Sql<{ bigint: bigint }>;
  campaignIdMap: Map<bigint, bigint>;
  rewardPeriods: LegacyCampaignRewardPeriod[];
}) {
  const map = new Map<bigint, bigint>();

  for (const period of rewardPeriods) {
    const newCampaignId = campaignIdMap.get(period.campaign_id);
    if (!newCampaignId) {
      console.log(campaignIdMap.entries(), period.campaign_id, newCampaignId);
      throw new Error(`Missing campaign mapping for id ${period.campaign_id}`);
    }

    const [inserted] = await sql<{ id: bigint }[]>`
      INSERT INTO incentives.campaign_reward_periods (
        campaign_id,
        token0,
        token1,
        start_time,
        end_time,
        realized_volatility,
        token0_reward_amount,
        token1_reward_amount,
        rewards_last_computed_at,
        percent_step,
        max_coverage,
        fee_denominator
      )
      VALUES (
        ${newCampaignId},
        ${period.token0 ?? ""},
        ${period.token1 ?? ""},
        ${period.start_time},
        ${period.end_time},
        ${period.realized_volatility ?? 0},
        ${period.token0_reward_amount ?? "0"},
        ${period.token1_reward_amount ?? "0"},
        ${period.rewards_last_computed_at ?? null},
        ${period.percent_step ?? null},
        ${period.max_coverage ?? null},
        ${period.fee_denominator ?? null}
      )
      RETURNING id;
    `;

    map.set(period.id, inserted.id);
  }

  console.log(
    `\tInserted ${rewardPeriods.length.toLocaleString()} campaign reward periods via sequential inserts`
  );

  return map;
}

async function importComputedRewards({
  sql,
  rewardPeriodMap,
  computedRewards,
}: {
  sql: Sql<{ bigint: bigint }>;
  rewardPeriodMap: Map<bigint, bigint>;
  computedRewards: LegacyRewardsComputedAt[];
}) {
  if (rewardPeriodMap.size === 0 || computedRewards.length === 0) {
    return 0;
  }

  let processedRows = 0;
  let skippedRows = 0;
  const startTime = Date.now();
  const progressInterval = 50_000;

  for (const row of computedRewards) {
    const mappedPeriodId = rewardPeriodMap.get(row.campaign_reward_period_id);
    if (!mappedPeriodId) {
      skippedRows += 1;
      continue;
    }

    await sql`
      INSERT INTO incentives.computed_rewards (
        campaign_reward_period_id,
        locker,
        salt,
        reward_amount
      )
      VALUES (
        ${mappedPeriodId},
        ${row.locker ?? ""},
        ${row.salt ?? ""},
        ${row.reward_amount ?? "0"}
      );
    `;

    processedRows += 1;
    if (processedRows % progressInterval === 0) {
      const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
      const rate = Math.round(processedRows / elapsedSeconds);
      console.log(
        `\t\tInserted ${processedRows.toLocaleString()} computed rewards (~${rate.toLocaleString()} rows/s)`
      );
    }
  }

  const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
  const finalRate =
    processedRows === 0 ? 0 : Math.round(processedRows / elapsedSeconds);

  console.log(
    `\tFinished inserting ${processedRows.toLocaleString()} computed rewards in ${elapsedSeconds.toFixed(
      1
    )}s (~${finalRate.toLocaleString()} rows/s)`
  );

  if (skippedRows > 0) {
    console.log(
      `\t\tSkipped ${skippedRows.toLocaleString()} legacy computed reward rows that did not map to current chain`
    );
  }

  return processedRows;
}

async function importDrops({
  sql,
  generatedDrops,
}: {
  sql: Sql<{ bigint: bigint }>;
  generatedDrops: LegacyGeneratedDrop[];
}) {
  const map = new Map<bigint, bigint>();

  for (const drop of generatedDrops) {
    const [inserted] = await sql<{ id: bigint }[]>`
      INSERT INTO incentives.generated_drop (root, generated_at)
      VALUES (${drop.root}, ${drop.generated_at})
      RETURNING id;
    `;

    map.set(drop.id, inserted.id);
  }

  return map;
}

async function importDropRewardPeriods({
  sql,
  records,
  dropIdMap,
  rewardPeriodMap,
}: {
  sql: Sql<{ bigint: bigint }>;
  records: LegacyGeneratedDropRewardPeriod[];
  dropIdMap: Map<bigint, bigint>;
  rewardPeriodMap: Map<bigint, bigint>;
}) {
  if (!records.length) return 0;

  let inserted = 0;
  const startTime = Date.now();
  const progressInterval = 50_000;

  for (const record of records) {
    const dropId = dropIdMap.get(record.drop_id);
    const periodId = rewardPeriodMap.get(record.campaign_reward_period_id);
    if (!dropId || !periodId) {
      throw new Error(
        `Missing drop (${record.drop_id.toString()}) or period (${record.campaign_reward_period_id.toString()}) mapping`
      );
    }

    await sql`
      INSERT INTO incentives.generated_drop_reward_periods (
        drop_id,
        campaign_reward_period_id
      )
      VALUES (${dropId}, ${periodId});
    `;

    inserted += 1;
    if (inserted % progressInterval === 0) {
      const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
      const rate = Math.round(inserted / elapsedSeconds);
      console.log(
        `\t\tLinked ${inserted.toLocaleString()} drop reward periods (~${rate.toLocaleString()} rows/s)`
      );
    }
  }

  return inserted;
}

async function importDropProofs({
  sql,
  proofs,
  dropIdMap,
}: {
  sql: Sql<{ bigint: bigint }>;
  proofs: LegacyGeneratedDropProof[];
  dropIdMap: Map<bigint, bigint>;
}) {
  if (!proofs.length) return 0;

  let inserted = 0;
  const startTime = Date.now();
  const progressInterval = 50_000;

  for (const proof of proofs) {
    const dropId = dropIdMap.get(proof.drop_id);
    if (!dropId) {
      throw new Error(
        `Missing drop mapping for proof ${proof.drop_id.toString()}`
      );
    }

    await sql`
      INSERT INTO incentives.generated_drop_proof (
        drop_id,
        id,
        address,
        amount,
        proof
      )
      VALUES (${dropId}, ${proof.id}, ${proof.address}, ${proof.amount}, ${proof.proof});
    `;

    inserted += 1;
    if (inserted % progressInterval === 0) {
      const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
      const rate = Math.round(inserted / elapsedSeconds);
      console.log(
        `\t\tInserted ${inserted.toLocaleString()} drop proofs (~${rate.toLocaleString()} rows/s)`
      );
    }
  }

  return inserted;
}

async function importDeployedContracts({
  sql,
  contracts,
  dropIdMap,
}: {
  sql: Sql<{ bigint: bigint }>;
  contracts: LegacyDeployedAirdropContract[];
  dropIdMap: Map<bigint, bigint>;
}) {
  if (!contracts.length) return 0;

  let inserted = 0;

  for (const contract of contracts) {
    const dropId = dropIdMap.get(contract.drop_id);
    if (!dropId) {
      throw new Error(
        `Missing drop mapping for deployed contract ${contract.address}`
      );
    }

    await sql`
      INSERT INTO incentives.deployed_airdrop_contracts (
        address,
        token,
        drop_id
      )
      VALUES (${contract.address}, ${contract.token}, ${dropId});
    `;

    inserted += 1;
  }

  return inserted;
}

async function importLegacyChain({
  targetSql,
  chainId,
  legacyConnectionString,
}: {
  targetSql: Sql<{ bigint: bigint }>;
  chainId: bigint;
  legacyConnectionString: string;
}) {
  const legacySql = postgres(legacyConnectionString, {
    connect_timeout: 5,
    types: { bigint: postgres.BigInt },
    max: 1,
  });

  console.log(
    `Starting incentives import for chain ${chainId.toString()} using ${legacyConnectionString}`
  );

  try {
    const snapshots = await withStepProgress(
      `\tFetching legacy snapshots for chain ${chainId.toString()}`,
      () => fetchAllLegacyData(legacySql)
    );

    console.log(
      `\tLegacy snapshots - campaigns: ${snapshots.campaigns.length}, drops: ${snapshots.generatedDrops.length}, drop proofs: ${snapshots.generatedDropProofs.length}`
    );

    await targetSql.begin(async (sql) => {
      const [{ count }] = await sql<{ count: bigint }[]>`
        SELECT COUNT(1) AS count
        FROM incentives.campaigns
        WHERE chain_id = ${chainId};
      `;

      if (count > 0n) {
        throw new Error(
          `Target database already has ${count.toString()} campaigns for chain ${chainId.toString()}`
        );
      }

      const campaignIdMap = await withStepProgress(
        `\tImporting ${snapshots.campaigns.length.toLocaleString()} campaigns`,
        () =>
          importCampaigns({
            sql,
            chainId,
            campaigns: snapshots.campaigns,
          })
      );

      const rewardPeriodMap = await withStepProgress(
        "\tImporting campaign reward periods",
        () =>
          importCampaignRewardPeriods({
            sql,
            campaignIdMap,
            rewardPeriods: snapshots.campaignRewardPeriods,
          })
      );

      const totalComputedRewards = await withStepProgress(
        `\tImporting computed rewards for ${rewardPeriodMap.size.toLocaleString()} periods (${snapshots.rewardsComputedAt.length.toLocaleString()} rows)`,
        () =>
          importComputedRewards({
            sql,
            rewardPeriodMap,
            computedRewards: snapshots.rewardsComputedAt,
          })
      );

      const dropIdMap = await withStepProgress(
        `\tImporting ${snapshots.generatedDrops.length.toLocaleString()} drops`,
        () =>
          importDrops({
            sql,
            generatedDrops: snapshots.generatedDrops,
          })
      );

      const dropPeriodsInserted = await withStepProgress(
        `\tLinking ${snapshots.generatedDropRewardPeriods.length.toLocaleString()} drop reward periods`,
        () =>
          importDropRewardPeriods({
            sql,
            records: snapshots.generatedDropRewardPeriods,
            dropIdMap,
            rewardPeriodMap,
          })
      );

      const dropProofsInserted = await withStepProgress(
        `\tImporting ${snapshots.generatedDropProofs.length.toLocaleString()} drop proofs`,
        () =>
          importDropProofs({
            sql,
            proofs: snapshots.generatedDropProofs,
            dropIdMap,
          })
      );

      const deployedContractsInserted = await withStepProgress(
        `\tImporting ${snapshots.deployedContracts.length.toLocaleString()} deployed contracts`,
        () =>
          importDeployedContracts({
            sql: sql,
            contracts: snapshots.deployedContracts,
            dropIdMap,
          })
      );

      console.log(
        [
          `\tImported ${campaignIdMap.size} campaigns`,
          `reward periods ${rewardPeriodMap.size}`,
          `computed rewards ${totalComputedRewards}`,
          `drops ${dropIdMap.size}`,
          `drop periods ${dropPeriodsInserted}`,
          `drop proofs ${dropProofsInserted}`,
          `deployed contracts ${deployedContractsInserted}`,
        ].join(", ")
      );
    });
  } finally {
    await legacySql.end({ timeout: 5 });
  }
}

async function truncateTargetTables(sql: Sql) {
  await sql`
    TRUNCATE TABLE
      incentives.deployed_airdrop_contracts,
      incentives.generated_drop_proof,
      incentives.generated_drop_reward_periods,
      incentives.generated_drop,
      incentives.computed_rewards,
      incentives.campaign_reward_periods,
      incentives.campaigns
    RESTART IDENTITY CASCADE;
  `;
}

async function main() {
  const connectionString = process.env.PG_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error("PG_CONNECTION_STRING must be set for the target database");
  }

  const chainSources = parseChainSources(process.argv.slice(2));
  if (chainSources.length === 0) {
    throw new Error(
      [
        "No legacy chain sources provided.",
        "Usage: bun scripts/import-legacy-incentives.ts --chain <chainId> <legacyPgConnectionString>",
        "Provide the flag 4 times (once per legacy chain).",
      ].join(" ")
    );
  }

  const targetSql = postgres(connectionString, {
    connect_timeout: 5,
    types: { bigint: postgres.BigInt },
  });

  try {
    await withStepProgress(
      "Truncating incentives tables in target database",
      () => truncateTargetTables(targetSql)
    );

    for (const [index, source] of chainSources.entries()) {
      const chainLabel = `Importing chain ${source.chainId.toString()} (${
        index + 1
      }/${chainSources.length})`;
      await withStepProgress(chainLabel, () =>
        importLegacyChain({
          targetSql,
          chainId: source.chainId,
          legacyConnectionString: source.connectionString,
        })
      );
    }

    console.log("Legacy incentives import complete");
  } finally {
    await targetSql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
