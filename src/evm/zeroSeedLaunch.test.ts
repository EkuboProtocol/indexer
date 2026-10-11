import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeEventLog, encodeEventTopics, toHex } from "viem";
import type { DAO } from "../_shared/dao";
import { CORE_ABI } from "./abis_v3";
import {
  ZERO_SEED_LAUNCH_ABI,
  ZERO_SEED_LAUNCH_ABI_SHA256,
} from "./abis_zero_seed_launch";
import { createLogProcessorsV3 } from "./logProcessorsV3";
import type { RawLog } from "./logStream";
import {
  resolveZeroSeedLaunchAddress,
  ZERO_SEED_LAUNCH_PINS,
  type ZeroSeedLaunchPin,
} from "./zeroSeedLaunchConfig";
import {
  createZeroSeedLaunchProcessors,
  launchCreatedProblems,
} from "./zeroSeedLaunchProcessors";

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../tests/fixtures/zero-seed-launch/local-chain.json"), "utf8"),
);
const LAUNCH = fixture.addresses.launch as `0x${string}`;
const CODEHASH = fixture.provenance.launchRuntimeKeccak as `0x${string}`;

// The CTO interface freeze (EKU-822 v1) pins.
const FROZEN = {
  abiSha256: "28d05c07218cbe7101dee3410f356820dbfcaa31b08e015aee5940a96950f23d",
  evmContractsHead: "39ca1918e4d16b1c9fd4db5ed70761ef7b12c6ae",
  evmContractsTree: "b95e748486d5bbf23635fcea73bd4825b3a36455",
  coreRuntimeKeccak: "0xc5f90c9d0dbc5037f8f9e248f4bb292e7c1824f584eb6550cb4cad525b38c71a",
  routerRuntimeKeccak: "0x32ba8475c95ee5d9f7807f4ad9dce849929c992df9c68e9030e986d1854e726f",
  topics: {
    LaunchCreated: "0xfe2a763a22e674e13e94ee2f603a671afd54b304fd050776ee150e36370e5dc4",
    LaunchSwapped: "0x3e58795f52a8e88efdec2da89ea3798175f8764145ccd7bf5e40633a7d571f6d",
    CreatorFeesClaimed: "0xda45e5fa280329970441a582e78cff0b8e25a17a5d56e3809ef3e6a0dcc078f5",
  },
};

// `jq -cS .`: keys sorted recursively, compact, newline-terminated.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

const config = {
  mevCaptureAddress: "0x0000000000000000000000000000000000000001",
  boostedFeesConcentratedAddress: "0x0000000000000000000000000000000000000002",
  boostedFeesStableswapAddress: "0x0000000000000000000000000000000000000003",
  coreAddress: fixture.addresses.core,
  oracleAddress: "0x0000000000000000000000000000000000000005",
  incentivesAddress: "0x0000000000000000000000000000000000000006",
  tokenWrapperFactoryAddress: "0x0000000000000000000000000000000000000007",
  auctionsAddress: "0x0000000000000000000000000000000000000008",
  twammAddresses: [] as `0x${string}`[],
  ordersAddresses: [] as `0x${string}`[],
  positionsContracts: [],
} as const;

const allLogs: RawLog[] = [
  ...fixture.branches.prefix.logs,
  ...fixture.branches.alternate.logs,
  ...fixture.branches.canonical.logs,
];
const LAUNCH_CREATED = FROZEN.topics.LaunchCreated;
const createdLogs = allLogs.filter((l) => l.topics[0] === LAUNCH_CREATED);
const keyOf = (log: RawLog) => ({
  blockNumber: Number(log.blockNumber),
  transactionIndex: Number(log.transactionIndex),
  eventIndex: Number(log.logIndex),
  emitter: log.address,
  transactionHash: log.transactionHash,
});
const decodeCreated = (log: RawLog) =>
  decodeEventLog({ abi: ZERO_SEED_LAUNCH_ABI, eventName: "LaunchCreated", topics: log.topics as [`0x${string}`], data: log.data, strict: true }).args;

describe("frozen interface", () => {
  it("the compiled ABI is the frozen one, byte for byte", () => {
    const sha = createHash("sha256").update(`${canonicalJson(ZERO_SEED_LAUNCH_ABI)}\n`).digest("hex");
    expect(sha).toBe(FROZEN.abiSha256);
    expect(ZERO_SEED_LAUNCH_ABI_SHA256).toBe(FROZEN.abiSha256);
    for (const [eventName, topic] of Object.entries(FROZEN.topics))
      expect(encodeEventTopics({ abi: ZERO_SEED_LAUNCH_ABI, eventName: eventName as "LaunchCreated" })[0]).toBe(topic as `0x${string}`);
  });

  it("the replay fixture came from the frozen contracts head over the pinned Core and router runtimes", () => {
    const p = fixture.provenance;
    expect([p.evmContractsHead, p.evmContractsTree, p.evmContractsDirty]).toEqual([FROZEN.evmContractsHead, FROZEN.evmContractsTree, false]);
    expect([p.coreRuntimeKeccak, p.routerRuntimeKeccak, p.launchAbiSha256]).toEqual([FROZEN.coreRuntimeKeccak, FROZEN.routerRuntimeKeccak, FROZEN.abiSha256]);
    expect(createdLogs.length).toBe(4);
  });
});

describe("launch support configuration", () => {
  const base = { chainId: 31337n, address: LAUNCH, runtimeCodehash: CODEHASH, production: false };
  const otherChainPin: ZeroSeedLaunchPin = { ...ZERO_SEED_LAUNCH_PINS[0]!, chainId: 8453n, local: false };

  it("the only pin is the local fixture deployment", () => {
    expect(ZERO_SEED_LAUNCH_PINS).toHaveLength(1);
    expect(ZERO_SEED_LAUNCH_PINS[0]).toMatchObject({ chainId: 31337n, address: LAUNCH.toLowerCase(), runtimeCodehash: CODEHASH, local: true });
  });

  it("is on only for a pinned address and codehash", () => {
    expect(resolveZeroSeedLaunchAddress(base)).toBe(LAUNCH.toLowerCase() as `0x${string}`);
  });

  it("is off when the address, codehash, chain id or the chain's pin is missing", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(resolveZeroSeedLaunchAddress({ ...base, address: undefined, warn })).toBeUndefined();
    expect(resolveZeroSeedLaunchAddress({ ...base, runtimeCodehash: undefined, warn })).toBeUndefined();
    expect(resolveZeroSeedLaunchAddress({ ...base, chainId: undefined, warn })).toBeUndefined();
    expect(resolveZeroSeedLaunchAddress({ ...base, chainId: 8453n, warn })).toBeUndefined();
    expect(warnings).toHaveLength(3);
  });

  it("refuses to start on a mismatch, an undeployed codehash, a local pin in production or another ABI", () => {
    expect(() => resolveZeroSeedLaunchAddress({ ...base, address: "0x5eed00000000000000000000000000000000ab01" })).toThrow(/not the pinned launch/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, runtimeCodehash: FROZEN.coreRuntimeKeccak as `0x${string}` })).toThrow(/does not match the pin/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, runtimeCodehash: "0x16d2d4ce55576f418d94b9dcef3e9d4950a0d3f1573af639f1387e1d6b74c319" })).toThrow(/not a deployed runtime/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, runtimeCodehash: toHex(0n, { size: 32 }) })).toThrow(/not a deployed runtime/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, production: true })).toThrow(/local fixture/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, chainId: 8453n, pins: [{ ...otherChainPin, abiSha256: "00" }] })).toThrow(/ABI/);
  });
});

describe("processors", () => {
  const launchFilters = (zeroSeedLaunchAddress?: `0x${string}`) =>
    createLogProcessorsV3({ ...config, zeroSeedLaunchAddress })
      .filter((p) => p.address.toLowerCase() === LAUNCH.toLowerCase())
      .map((p) => p.filter.topics[0]);

  it("decode exactly the three frozen events, and nothing without an address", () => {
    expect(launchFilters(LAUNCH).sort()).toEqual(Object.values(FROZEN.topics).sort() as `0x${string}`[]);
    expect(launchFilters(undefined)).toEqual([]);
  });

  it("register a launch pool at PoolInitialized only when support is on", async () => {
    const poolInitialized = fixture.branches.prefix.logs.find(
      (l: RawLog) => l.topics[0] === encodeEventTopics({ abi: CORE_ABI, eventName: "PoolInitialized" })[0],
    ) as RawLog;
    for (const [address, expected] of [[LAUNCH, 1], [undefined, 0]] as const) {
      const registered: string[] = [];
      const dao = {
        insertPoolInitializedEvent: async () => {},
        insertMEVCapturePoolKey: async () => {},
        insertZeroSeedLaunchPoolKey: async (_core: string, poolId: string) => void registered.push(poolId),
      } as unknown as DAO;
      const processors = createLogProcessorsV3({ ...config, zeroSeedLaunchAddress: address });
      const core = processors.find((p) => p.address === config.coreAddress && p.filter.topics[0] === poolInitialized.topics[0])!;
      await core.handler(dao, keyOf(poolInitialized), poolInitialized);
      expect(registered).toHaveLength(expected);
    }
  });
});

describe("LaunchCreated decoder guards", () => {
  it("accept every chain-emitted LaunchCreated", () => {
    for (const log of createdLogs) expect(launchCreatedProblems(keyOf(log), decodeCreated(log))).toEqual([]);
  });

  it("refuse logs whose fields disagree, and the handler stores nothing", async () => {
    const log = createdLogs[0]!;
    const event = decodeCreated(log);
    const mutants: [string, typeof event, string][] = [
      ["liquidity", { ...event, liquidity: event.liquidity + 1n }, "parameters.liquidity != liquidity"],
      ["emitter", event, "pool extension is not the emitter"],
      ["poolId", { ...event, poolId: toHex(1n, { size: 32 }) }, "poolId != id of poolKey"],
      ["order", { ...event, poolKey: { ...event.poolKey, token0: event.poolKey.token1, token1: event.poolKey.token0 } }, "pool tokens are not (token, quoteToken) in order"],
      ["position", { ...event, positionId: toHex(BigInt(event.positionId) + 1n, { size: 32 }) }, "position is not (salt 0, tick_lower, tick_upper)"],
      ["fee", { ...event, poolKey: { ...event.poolKey, config: toHex(BigInt(event.poolKey.config) | (1n << 64n), { size: 32 }) } }, "Core fee is not 0"],
    ];
    for (const [name, mutated, problem] of mutants) {
      const key = name === "emitter" ? { ...keyOf(log), emitter: config.coreAddress } : keyOf(log);
      expect(launchCreatedProblems(key, mutated)).toContain(problem);
    }
    const [created] = createZeroSeedLaunchProcessors({ coreAddress: config.coreAddress, zeroSeedLaunchAddress: LAUNCH })
      .filter((p) => p.filter.topics[0] === LAUNCH_CREATED);
    const dao = { insertZeroSeedLaunchCreatedEvent: async () => { throw new Error("must not store"); } } as unknown as DAO;
    await expect(created!.handler(dao, { ...keyOf(log), emitter: config.coreAddress }, log)).rejects.toThrow(/Refusing LaunchCreated/);
  });
});
