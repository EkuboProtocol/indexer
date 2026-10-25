import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import shift from "postgres-shift";
import {
  decodeEventLog,
  encodeAbiParameters,
  numberToHex,
  type AbiEvent,
} from "viem";
import { DAO, NumericIntegerType } from "../_shared/dao";
import { parseEvmBlockHeader, processEvmBlock } from "../evm";
import { CORE_ABI } from "./abis_v3";
import {
  LAUNCH_TOKEN_ABI,
  ZERO_SEED_LAUNCH_ABI,
} from "./abis_zero_seed_launch";
import { createLogProcessorsV3 } from "./logProcessorsV3";
import type { EvmLogProcessor } from "./logProcessorsShared";
import { groupLogsByBlock, type RawLog } from "./logStream";
import type { ZeroSeedLaunchPin } from "./zeroSeedLaunchConfig";
import type { LaunchCreated } from "./zeroSeedLaunchProcessors";

// Replays the frozen raw receipt logs of evm-contracts 853b608
// (zero-seed-launch-events.json: one launch created, swapped, claimed and
// transferred through the periphery, with its LaunchToken Transfer and
// Approval logs) through the processors and DAO on Postgres, once per
// LaunchCreated fixture (empty and nonempty logo).
//
// The frozen receipts carry only launch logs. The Core PoolInitialized and
// PositionUpdated that precede LaunchCreated are taken from launch l1 of the
// local anvil chain, which has the same geometry, supply and native quote
// (equal installed liquidity and supply, checked below), with the pool
// identity and locker rewritten to the frozen launch's.

type Hex = `0x${string}`;
const SERVER = process.env.TEST_PG_CONNECTION_STRING;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const json = <T>(path: string) =>
  JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as T;
const frozen = json<{
  LaunchCreated: { logo: string; topics: Hex[]; data: Hex }[];
  receipt: { emitter: Hex; topics: Hex[]; data: Hex }[];
}>(
  "tests/fixtures/zero-seed-launch/freeze-853b608/zero-seed-launch-events.json",
);
const chain = json<{
  addresses: { core: Hex };
  launches: Record<
    string,
    {
      poolId: Hex;
      liquidity: string;
      installedSupply: string;
      sinkSupply: string;
    }
  >;
  branches: { prefix: { logs: RawLog[] } };
}>("tests/fixtures/zero-seed-launch/local-chain.json");

const CORE = chain.addresses.core;
const EXTENSION: Hex = "0x5100000000000000000000000000000000000000";
const PERIPHERY: Hex = "0xF62849F9A0B5Bf2913b396098F7c7019b51A820a";
const CHAIN_ID = 31337n;
const PIN: ZeroSeedLaunchPin = {
  chainId: CHAIN_ID,
  address: EXTENSION,
  runtimeCodehash: `0x${"ab".repeat(32)}`,
  periphery: PERIPHERY,
  core: CORE,
  deploymentBlock: 1,
  local: true,
  source: "frozen receipts",
};
const unused = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const processors: EvmLogProcessor[] = createLogProcessorsV3({
  mevCaptureAddress: unused(1),
  boostedFeesConcentratedAddress: unused(2),
  boostedFeesStableswapAddress: unused(3),
  coreAddress: CORE,
  oracleAddress: unused(4),
  incentivesAddress: unused(5),
  tokenWrapperFactoryAddress: unused(6),
  auctionsAddress: unused(7),
  twammAddresses: [],
  ordersAddresses: [],
  positionsContracts: [],
  zeroSeedLaunchPins: [PIN],
});
const filters = processors.map((p, ix) => ({
  id: ix + 1,
  address: p.address,
  topics: p.filter.topics,
  strict: p.filter.strict,
}));

const coreEvent = (name: string) =>
  CORE_ABI.find((i) => i.type === "event" && i.name === name) as AbiEvent;

/** l1's Core logs of its creation, re-encoded for the frozen launch. */
function coreCreationLogs(created: { topics: Hex[]; data: Hex }) {
  const event = decodeEventLog({
    abi: ZERO_SEED_LAUNCH_ABI,
    eventName: "LaunchCreated",
    topics: created.topics as [Hex],
    data: created.data,
    strict: true,
  }).args as LaunchCreated;
  const l1 = chain.launches.l1;
  expect([
    String(event.liquidity),
    event.parameters.supply - BigInt(l1.sinkSupply),
  ]).toEqual([l1.liquidity, BigInt(l1.installedSupply)]);
  const fromChain = (name: string) =>
    chain.branches.prefix.logs.filter((log) => {
      if (BigInt(log.address) !== BigInt(CORE)) return false;
      try {
        const d = decodeEventLog({
          abi: [coreEvent(name)],
          topics: log.topics as [Hex],
          data: log.data,
          strict: true,
        });
        return (d.args as { poolId: Hex }).poolId === l1.poolId;
      } catch {
        return false;
      }
    });
  const [initialized] = fromChain("PoolInitialized");
  const [position] = fromChain("PositionUpdated");
  const init = decodeEventLog({
    abi: [coreEvent("PoolInitialized")],
    topics: initialized.topics as [Hex],
    data: initialized.data,
    strict: true,
  }).args as unknown as { tick: number; sqrtRatio: bigint };
  const pos = decodeEventLog({
    abi: [coreEvent("PositionUpdated")],
    topics: position.topics as [Hex],
    data: position.data,
    strict: true,
  }).args as unknown as {
    liquidityDelta: bigint;
    balanceUpdate: Hex;
    stateAfter: Hex;
  };
  return [
    {
      topics: initialized.topics,
      data: encodeAbiParameters(coreEvent("PoolInitialized").inputs, [
        event.poolId,
        event.poolKey,
        init.tick,
        init.sqrtRatio,
      ]),
    },
    {
      topics: position.topics,
      data: encodeAbiParameters(coreEvent("PositionUpdated").inputs, [
        EXTENSION,
        event.poolId,
        event.positionId,
        pos.liquidityDelta,
        pos.balanceUpdate,
        pos.stateAfter,
      ]),
    },
  ];
}

/**
 * Two blocks: the creation transaction (Core logs, the two mints,
 * LaunchCreated, the first owner), then approve + swap, claim, transfer.
 */
function frozenLogs(created: { topics: Hex[]; data: Hex }): RawLog[] {
  const r = frozen.receipt;
  const creation = [
    ...coreCreationLogs(created).map((l) => ({ emitter: CORE, ...l })),
    r[0],
    r[1],
    { emitter: EXTENSION, ...created },
    r[3],
  ];
  const txs: { block: number; logs: typeof creation }[] = [
    { block: 1, logs: creation },
    { block: 2, logs: [r[4], r[5]] },
    { block: 2, logs: [r[6], r[7], r[8], r[9]] },
    { block: 2, logs: [r[10]] },
  ];
  const out: RawLog[] = [];
  const logIndex = new Map<number, number>();
  const txIndex = new Map<number, number>();
  for (const tx of txs) {
    const ti = txIndex.get(tx.block) ?? 0;
    txIndex.set(tx.block, ti + 1);
    for (const log of tx.logs) {
      const li = logIndex.get(tx.block) ?? 0;
      logIndex.set(tx.block, li + 1);
      out.push({
        address: log.emitter,
        topics: log.topics,
        data: log.data,
        blockHash: numberToHex(tx.block, { size: 32 }),
        blockNumber: numberToHex(tx.block),
        blockTimestamp: numberToHex(1000 + tx.block),
        transactionHash: numberToHex(tx.block * 1000 + ti, { size: 32 }),
        transactionIndex: numberToHex(ti),
        logIndex: numberToHex(li),
      });
    }
  }
  return out;
}

describe.skipIf(!SERVER)(
  "frozen 853b608 receipts through the launch processors on Postgres",
  () => {
    const template = `zslf_template_${process.pid}_${Date.now()}`;
    const created: string[] = [];
    let admin: Sql;

    const urlFor = (database: string) => {
      const url = new URL(SERVER!);
      url.pathname = `/${database}`;
      return url.toString();
    };

    beforeAll(async () => {
      admin = postgres(SERVER!, { max: 1, onnotice: () => {} });
      await admin.unsafe(`CREATE DATABASE ${template}`);
      const sql = postgres(urlFor(template), { max: 1, onnotice: () => {} });
      await shift({ sql, path: resolve(ROOT, "migrations") });
      await sql.end();
    }, 300_000);

    afterAll(async () => {
      for (const name of [...created, template])
        await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin?.end();
    }, 60_000);

    async function freshDb() {
      const name = `${template}_${created.length + 1}`;
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      created.push(name);
      const sql = postgres(urlFor(name), {
        max: 1,
        onnotice: () => {},
        types: { bigint: postgres.BigInt, numeric: NumericIntegerType },
      }) as unknown as Sql<{ bigint: bigint; numeric: bigint }>;
      await sql`INSERT INTO indexer_cursor (chain_id, order_key, unique_key, last_updated, fork_counter)
              VALUES (${CHAIN_ID}, 0, NULL, NOW(), 0)`;
      return { sql, dao: Reflect.construct(DAO, [sql, CHAIN_ID]) as DAO };
    }

    async function replay(dao: DAO, logs: RawLog[]) {
      for (const block of groupLogsByBlock(logs, filters)) {
        const parsed = parseEvmBlockHeader(block)!;
        await dao.begin(async (tx) => {
          await tx.deleteOldBlockNumbers(parsed.header.number);
          await tx.insertBlock({
            number: parsed.header.number,
            hash: parsed.header.hash,
            time: new Date(parsed.header.timestamp),
            baseFeePerGas: null,
            numEvents: block.logs.reduce(
              (n, log) => n + log.filterIds.length,
              0,
            ),
          });
          await processEvmBlock(
            processors,
            parsed.block,
            parsed.header.number,
            tx,
          );
        });
      }
    }

    async function state(sql: Sql<{ bigint: bigint; numeric: bigint }>) {
      const q = (text: string) =>
        sql.unsafe(text).then((rows) => rows.map((r) => ({ ...r })));
      return {
        created: await q(
          `SELECT c.*, NULL AS pool_key_id FROM zero_seed_launch_created c`,
        ),
        swapped: await q(
          `SELECT w.*, NULL AS pool_key_id FROM zero_seed_launch_swapped w`,
        ),
        claims: await q(
          `SELECT c.*, NULL AS pool_key_id FROM zero_seed_launch_claims c`,
        ),
        owners: await q(
          `SELECT o.*, NULL AS pool_key_id FROM zero_seed_launch_owner_changed o ORDER BY event_id`,
        ),
        states: await q(
          `SELECT s.*, NULL AS pool_key_id FROM zero_seed_launch_states s`,
        ),
      };
    }

    for (const launch of frozen.LaunchCreated)
      test(`all seven events, logo ${JSON.stringify(launch.logo)}: stored once, reconciled, replay-stable`, async () => {
        const logs = frozenLogs(launch);
        const { sql, dao } = await freshDb();
        await replay(dao, logs);
        const s = await state(sql);

        // LaunchToken Transfer/Approval logs match no filter: not streamed.
        const matched = groupLogsByBlock(logs, filters).flatMap((b) => b.logs);
        expect(
          matched.some(
            (l) => BigInt(l.address) === BigInt(frozen.receipt[0].emitter),
          ),
        ).toBe(false);

        expect(s.created).toHaveLength(1);
        const [c] = s.created as Record<string, unknown>[];
        expect({
          name: c.name,
          symbol: c.symbol,
          logo_url: c.logo_url,
          logo_bytes: (c.logo_url_bytes as Buffer).toString("utf8"),
          quote_kind: c.quote_kind,
          controller: c.controller,
          tick_spacing: c.tick_spacing,
          aligned: [
            c.aligned_ask_tick,
            c.aligned_upper_tick,
            c.tick_lower,
            c.tick_upper,
          ],
          requested: c.requested_supply,
          sink: c.sink_supply,
          decay: c.decay_rate_x32,
        }).toEqual({
          name: "Zero Seed",
          symbol: "ZERO",
          logo_url: launch.logo,
          logo_bytes: launch.logo,
          quote_kind: "native",
          controller: BigInt(PERIPHERY),
          tick_spacing: 17990n,
          aligned: [-13798330, -9210880, 9210880, 13798330],
          requested: 10n ** 27n,
          sink: 441n,
          decay: 68913100933n,
        });

        // Supply from the raw mint Transfers: installed to Core, sink to 0.
        const mints = frozen.receipt.slice(0, 2).map(
          (log) =>
            decodeEventLog({
              abi: LAUNCH_TOKEN_ABI,
              eventName: "Transfer",
              topics: log.topics as [Hex],
              data: log.data,
              strict: true,
            }).args as { to: Hex; amount: bigint },
        );
        expect(mints.map((m) => [BigInt(m.to), m.amount])).toEqual([
          [BigInt(CORE), c.installed_supply as bigint],
          [0n, c.sink_supply as bigint],
        ]);

        // One claim, keyed on the extension event, with the periphery's owner
        // and recipient; the ledger counts it once.
        const { feeAmount: fee } = decodeEventLog({
          abi: ZERO_SEED_LAUNCH_ABI,
          eventName: "LaunchSwapped",
          topics: frozen.receipt[5].topics as [Hex],
          data: frozen.receipt[5].data,
          strict: true,
        }).args as { feeAmount: bigint };
        expect(s.swapped).toHaveLength(1);
        expect(s.claims).toHaveLength(1);
        const owner = BigInt("0x2190d584e30f4a2396c1487aa784428f2068cbe8");
        expect(s.claims[0]).toMatchObject({
          owner,
          recipient: owner,
          amount0: 0n,
          amount1: fee,
        });
        expect(s.states[0]).toMatchObject({
          accrued0: 0n,
          accrued1: fee,
          claimed0: 0n,
          claimed1: fee,
          paid1: fee,
          swap_count: 1n,
          claim_count: 1n,
          initial_owner: owner,
          current_owner: 0xbeefn,
          owner_change_count: 2n,
        });

        // Re-processing the same blocks, and a full second replay, change nothing.
        await replay(dao, logs);
        expect(await state(sql)).toEqual(s);
        const second = await freshDb();
        await replay(second.dao, logs);
        expect(await state(second.sql)).toEqual(s);
        await sql.end();
        await second.sql.end();
      }, 120_000);
  },
);
