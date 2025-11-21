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

type ChainSource = {
  chainId: bigint;
  connectionString: string;
};

function decodeCopyField(value: string): string | null {
  if (value === "\\N") return null;
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char !== "\\") {
      result += char;
      continue;
    }
    i += 1;
    if (i >= value.length) {
      throw new Error("Unexpected end of copy field escape sequence");
    }
    const next = value[i];
    switch (next) {
      case "b":
        result += "\b";
        break;
      case "f":
        result += "\f";
        break;
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "v":
        result += "\v";
        break;
      case "\\":
        result += "\\";
        break;
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        let octal = next;
        for (let j = 0; j < 2; j++) {
          const peek = value[i + 1];
          if (peek && /[0-7]/.test(peek)) {
            octal += peek;
            i += 1;
          } else {
            break;
          }
        }
        result += String.fromCharCode(parseInt(octal, 8));
        break;
      }
      default:
        result += next;
    }
  }
  return result;
}

async function* iterateCopyRows(
  readable: AsyncIterable<Buffer>
): AsyncGenerator<(string | null)[]> {
  let buffer = "";
  for await (const chunk of readable) {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line === "\\.") {
        newlineIndex = buffer.indexOf("\n");
        continue;
      }
      const fields = line.split("\t").map(decodeCopyField);
      yield fields;
      newlineIndex = buffer.indexOf("\n");
    }
  }
  const trimmed = buffer.trim();
  if (trimmed.length && trimmed !== "\\.") {
    throw new Error("Unexpected trailing data in COPY stream");
  }
}

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

async function fetchLegacySnapshots(sql: Sql) {
  const [
    campaigns,
    generatedDrops,
    generatedDropRewardPeriods,
    generatedDropProofs,
    deployedContracts,
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
      SELECT drop_id, id, address, amount, proof
      FROM incentives.generated_drop_proof
      ORDER BY drop_id, id;
    `,
    sql<LegacyDeployedAirdropContract[]>`
      SELECT address, token, drop_id
      FROM incentives.deployed_airdrop_contracts
      ORDER BY address;
    `,
  ]);

  return {
    campaigns,
    generatedDrops,
    generatedDropRewardPeriods,
    generatedDropProofs,
    deployedContracts,
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
  const map = new Map<string, bigint>();

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
    map.set(String(campaign.id), inserted.id);
  }

  return map;
}

async function importCampaignRewardPeriods({
  sql,
  legacySql,
  campaignIdMap,
}: {
  sql: Sql<{ bigint: bigint }>;
  legacySql: Sql<{ bigint: bigint }>;
  campaignIdMap: Map<string, bigint>;
}) {
  const map = new Map<string, bigint>();

  const insertPageSize = Math.floor(65535 / 14);
  const buffer: LegacyCampaignRewardPeriod[] = [];

  const readableStream = await legacySql`
    COPY (
      SELECT
        id,
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
      FROM incentives.campaign_reward_periods
      ORDER BY id
    )
    TO STDOUT WITH (FORMAT text)
  `.readable();

  let totalRows = 0;

  const flushBuffer = async () => {
    if (!buffer.length) return;
    const slice = buffer.splice(0, buffer.length);
    const inserted = await sql<{ id: bigint }[]>`
      INSERT INTO incentives.campaign_reward_periods ${sql(slice)} RETURNING id;
    `;
    inserted.forEach(({ id }, ix) => {
      map.set(String(slice[ix].id), id);
    });
  };

  for await (const row of iterateCopyRows(readableStream)) {
    const [
      id,
      campaignId,
      token0,
      token1,
      startTime,
      endTime,
      realizedVolatility,
      token0RewardAmount,
      token1RewardAmount,
      rewardsLastComputedAt,
      percentStep,
      maxCoverage,
      feeDenominator,
    ] = row;

    if (!id || !campaignId) {
      throw new Error("Reward period row missing id or campaign_id");
    }

    const newCampaignId = campaignIdMap.get(campaignId);
    if (!newCampaignId) {
      throw new Error(`Missing campaign mapping for id ${campaignId}`);
    }

    if (!startTime || !endTime) {
      throw new Error("Reward period row missing start_time or end_time");
    }

    buffer.push({
      id: BigInt(id),
      campaign_id: newCampaignId,
      token0: token0 ?? "",
      token1: token1 ?? "",
      start_time: new Date(startTime ?? ""),
      end_time: new Date(endTime ?? ""),
      realized_volatility: realizedVolatility ? Number(realizedVolatility) : 0,
      token0_reward_amount: token0RewardAmount ?? "0",
      token1_reward_amount: token1RewardAmount ?? "0",
      rewards_last_computed_at: rewardsLastComputedAt
        ? new Date(rewardsLastComputedAt)
        : null,
      percent_step: percentStep ? Number(percentStep) : null,
      max_coverage: maxCoverage ? Number(maxCoverage) : null,
      fee_denominator: feeDenominator ?? null,
    });

    totalRows += 1;
    if (buffer.length >= insertPageSize) {
      await flushBuffer();
    }
  }

  await flushBuffer();

  console.log(
    `\tInserted ${totalRows.toLocaleString()} campaign reward periods via streaming`
  );

  return map;
}

async function importComputedRewards({
  sql,
  legacySql,
  rewardPeriodMap,
}: {
  sql: Sql<{ bigint: bigint }>;
  legacySql: Sql<{ bigint: bigint }>;
  rewardPeriodMap: Map<string, bigint>;
}) {
  if (rewardPeriodMap.size === 0) {
    return 0;
  }

  console.log(
    `	Fetching all computed rewards rows (legacy set: ${rewardPeriodMap.size.toLocaleString()} periods)`
  );

  const startTime = Date.now();
  const rows = await legacySql<
    {
      campaign_reward_period_id: bigint;
      locker: string;
      salt: string;
      reward_amount: string;
    }[]
  >`
    SELECT
      campaign_reward_period_id,
      locker,
      salt,
      reward_amount
    FROM incentives.computed_rewards
    limit 100
  `;

  console.log(
    `	Fetched ${rows.length.toLocaleString()} computed reward rows from legacy database`
  );

  let processedRows = 0;
  let skippedRows = 0;
  let processedPeriods = 0;
  let previousLegacyPeriod: string | null = null;

  for (const row of rows) {
    const legacyPeriodId = row.campaign_reward_period_id?.toString();
    if (!legacyPeriodId) {
      throw new Error("Computed reward row missing campaign_reward_period_id");
    }

    const mappedPeriodId = rewardPeriodMap.get(legacyPeriodId);
    if (!mappedPeriodId) {
      skippedRows += 1;
      continue;
    }

    if (legacyPeriodId !== previousLegacyPeriod) {
      processedPeriods += 1;
      previousLegacyPeriod = legacyPeriodId;
      console.log(
        `		Processing computed rewards period ${processedPeriods.toLocaleString()}/${rewardPeriodMap.size.toLocaleString()} (legacy id ${legacyPeriodId})`
      );
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
      )
      ON CONFLICT (campaign_reward_period_id, locker, salt)
      DO NOTHING;
    `;

    processedRows += 1;
    if (processedRows % 50_000 === 0) {
      const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
      const rate = Math.round(processedRows / elapsedSeconds);
      console.log(
        `		Inserted ${processedRows.toLocaleString()} computed rewards (~${rate.toLocaleString()} rows/s)`
      );
    }
  }

  const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
  const finalRate = Math.round(
    processedRows === 0 ? 0 : processedRows / elapsedSeconds
  );

  console.log(
    `	Finished inserting ${processedRows.toLocaleString()} computed rewards in ${elapsedSeconds.toFixed(
      1
    )}s (~${finalRate.toLocaleString()} rows/s)`
  );

  if (skippedRows > 0) {
    console.log(
      `		Skipped ${skippedRows.toLocaleString()} legacy computed reward rows that did not map to current chain`
    );
  }

  return processedRows;
}

async function importDrops({
  sql,
  generatedDrops,
}: {
  sql: Sql;
  generatedDrops: LegacyGeneratedDrop[];
}) {
  const map = new Map<string, bigint>();

  for (const drop of generatedDrops) {
    const [inserted] = await sql<{ id: bigint }[]>`
      INSERT INTO incentives.generated_drop (root, generated_at)
      VALUES (${drop.root}, ${drop.generated_at})
      RETURNING id;
    `;

    map.set(String(drop.id), inserted.id);
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
  dropIdMap: Map<string, bigint>;
  rewardPeriodMap: Map<string, bigint>;
}) {
  if (!records.length) return 0;

  const rows = records.map((record) => {
    const dropId = dropIdMap.get(String(record.drop_id));
    const periodId = rewardPeriodMap.get(
      String(record.campaign_reward_period_id)
    );
    if (!dropId || !periodId) {
      throw new Error(
        `Missing drop (${record.drop_id.toString()}) or period (${record.campaign_reward_period_id.toString()}) mapping`
      );
    }

    return {
      drop_id: dropId,
      campaign_reward_period_id: periodId,
    };
  });

  await sql`
    INSERT INTO incentives.generated_drop_reward_periods ${sql(rows)}
    ON CONFLICT (drop_id, campaign_reward_period_id)
    DO NOTHING;
  `;

  return rows.length;
}

async function importDropProofs({
  sql,
  proofs,
  dropIdMap,
}: {
  sql: Sql<{ bigint: bigint }>;
  proofs: LegacyGeneratedDropProof[];
  dropIdMap: Map<string, bigint>;
}) {
  if (!proofs.length) return 0;

  const rows = proofs.map((proof) => {
    const dropId = dropIdMap.get(String(proof.drop_id));
    if (!dropId) {
      throw new Error(
        `Missing drop mapping for proof ${proof.drop_id.toString()}`
      );
    }
    return {
      drop_id: dropId,
      id: proof.id,
      address: proof.address,
      amount: proof.amount,
      proof: proof.proof,
    };
  });

  await sql`
    INSERT INTO incentives.generated_drop_proof ${sql(rows)}
    ON CONFLICT (drop_id, id)
    DO NOTHING;
  `;

  return rows.length;
}

async function importDeployedContracts({
  sql,
  contracts,
  dropIdMap,
}: {
  sql: Sql<{ bigint: bigint }>;
  contracts: LegacyDeployedAirdropContract[];
  dropIdMap: Map<string, bigint>;
}) {
  if (!contracts.length) return 0;

  const rows = contracts.map((contract) => {
    const dropId = dropIdMap.get(String(contract.drop_id));
    if (!dropId) {
      throw new Error(
        `Missing drop mapping for deployed contract ${contract.address}`
      );
    }

    return {
      address: contract.address,
      token: contract.token,
      drop_id: dropId,
    };
  });

  await sql`
    INSERT INTO incentives.deployed_airdrop_contracts ${sql(rows)}
    ON CONFLICT (address)
    DO NOTHING;
  `;

  return rows.length;
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
  });

  console.log(
    `Starting incentives import for chain ${chainId.toString()} using ${legacyConnectionString}`
  );

  try {
    const snapshots = await withStepProgress(
      `\tFetching legacy snapshots for chain ${chainId.toString()}`,
      () => fetchLegacySnapshots(legacySql)
    );

    await targetSql.begin(async (tx) => {
      const [{ count }] = await tx<{ count: bigint }[]>`
        SELECT COUNT(1) AS count
        FROM incentives.campaigns
        WHERE chain_id = ${chainId};
      `;

      if (count > 0n) {
        throw new Error(
          `Target database already has ${count.toString()} campaigns for chain ${chainId.toString()}`
        );
      }

      console.log(
        `\tLegacy snapshots - campaigns: ${snapshots.campaigns.length}, drops: ${snapshots.generatedDrops.length}, drop proofs: ${snapshots.generatedDropProofs.length}`
      );

      const campaignIdMap = await withStepProgress(
        `\tImporting ${snapshots.campaigns.length.toLocaleString()} campaigns`,
        () =>
          importCampaigns({
            sql: tx,
            chainId,
            campaigns: snapshots.campaigns,
          })
      );

      const rewardPeriodMap = await withStepProgress(
        "\tImporting campaign reward periods",
        () =>
          importCampaignRewardPeriods({
            sql: tx,
            legacySql,
            campaignIdMap,
          })
      );

      const totalComputedRewards = await withStepProgress(
        `\tImporting computed rewards for ${rewardPeriodMap.size.toLocaleString()} periods`,
        () =>
          importComputedRewards({
            sql: tx,
            legacySql,
            rewardPeriodMap,
          })
      );

      const dropIdMap = await withStepProgress(
        `\tImporting ${snapshots.generatedDrops.length.toLocaleString()} drops`,
        () =>
          importDrops({
            sql: tx,
            generatedDrops: snapshots.generatedDrops,
          })
      );

      const dropPeriodsInserted = await withStepProgress(
        `\tLinking ${snapshots.generatedDropRewardPeriods.length.toLocaleString()} drop reward periods`,
        () =>
          importDropRewardPeriods({
            sql: tx,
            records: snapshots.generatedDropRewardPeriods,
            dropIdMap,
            rewardPeriodMap,
          })
      );

      const dropProofsInserted = await withStepProgress(
        `\tImporting ${snapshots.generatedDropProofs.length.toLocaleString()} drop proofs`,
        () =>
          importDropProofs({
            sql: tx,
            proofs: snapshots.generatedDropProofs,
            dropIdMap,
          })
      );

      const deployedContractsInserted = await withStepProgress(
        `\tImporting ${snapshots.deployedContracts.length.toLocaleString()} deployed contracts`,
        () =>
          importDeployedContracts({
            sql: tx,
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
