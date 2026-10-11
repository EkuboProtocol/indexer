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

// The CTO interface freeze (EKU-822 v2) pins.
const FROZEN = {
  abiSha256: "189ff93c0f6fb64f6e7dd0675872bf6686692f8303e6218b8c2521bfa5ced215",
  evmContractsHead: "d6aeb58d845aa29454f3ed8df15e84a306a6f26d",
  evmContractsTree: "28946ed5a980df9cd030931e365741fe6b971b50",
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
    expect(fixture.forkPoint).toBe(Math.max(...fixture.branches.prefix.blocks.map((b: { number: number }) => b.number)));
    for (const branch of [fixture.branches.alternate, fixture.branches.canonical])
      expect(branch.logs.every((l: RawLog) => Number(l.blockNumber) > fixture.forkPoint)).toBe(true);
    for (const log of createdLogs) {
      const event = decodeCreated(log);
      const launch = Object.values(fixture.launches).find((l) => (l as { poolId: string }).poolId === event.poolId) as { label: string; extension: string };
      const installation = fixture.installations[launch.label];
      expect([String(event.parameters.supply), String(event.liquidity), Number(event.parameters.tradingStart), log.address.toLowerCase()])
        .toEqual([installation.actualInstalledSupply, installation.actualLiquidity, installation.tradingStart, installation.extension.toLowerCase()]);
      expect(BigInt(installation.requestedSupply) >= event.parameters.supply).toBe(true);
    }
  });
});

describe("launch support configuration", () => {
  const base = { chainId: 31337n, address: LAUNCH, runtimeCodehash: CODEHASH, coreAddress: fixture.addresses.core, production: false };
  const otherChainPin: ZeroSeedLaunchPin = { ...ZERO_SEED_LAUNCH_PINS[0]!, chainId: 8453n, local: false };

  it("only relocated plain-WETH fixture instances are pinned; live and arithmetic pins are absent", () => {
    expect(ZERO_SEED_LAUNCH_PINS).toHaveLength(2);
    expect(ZERO_SEED_LAUNCH_PINS[0]).toMatchObject({ chainId: 31337n, address: LAUNCH.toLowerCase(), runtimeCodehash: CODEHASH, local: true });
    for (const pin of ZERO_SEED_LAUNCH_PINS) {
      const instance = fixture.instances.find((i: { address: string }) => i.address.toLowerCase() === pin.address)!;
      expect([instance.quote.toLowerCase(), instance.runtimeKeccak]).toEqual([pin.quoteToken, pin.runtimeCodehash]);
      expect(pin.quoteRuntimeCodehash).toBe(fixture.provenance.wethRuntimeKeccak);
      expect(pin.local).toBe(true);
    }
    expect(() => createZeroSeedLaunchProcessors({ coreAddress: fixture.addresses.core, zeroSeedLaunchAddress: fixture.launches.l2.extension })).toThrow(/provenance/);
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
    expect(() => resolveZeroSeedLaunchAddress({ ...base, runtimeCodehash: "0xa85c864302696dce32b5e2452508219bb08323c142b40fb7c487540db3f75d89" })).toThrow(/not a deployed runtime/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, runtimeCodehash: toHex(0n, { size: 32 }) })).toThrow(/not a deployed runtime/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, production: true })).toThrow(/local fixture/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, chainId: 8453n, pins: [{ ...otherChainPin, abiSha256: "00" }] })).toThrow(/ABI/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, coreAddress: undefined })).toThrow(/Core/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, coreAddress: "0x0000000000000000000000000000000000000001" })).toThrow(/Core/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, pins: [{ ...ZERO_SEED_LAUNCH_PINS[0]!, quoteRuntimeCodehash: toHex(0n, { size: 32 }) }] })).toThrow(/quote/);
    expect(() => resolveZeroSeedLaunchAddress({ ...base, pins: [{ ...ZERO_SEED_LAUNCH_PINS[0]!, quoteToken: fixture.addresses.quote6 }] })).toThrow(/provenance/);
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
    for (const log of createdLogs) {
      const event = decodeCreated(log);
      // Pure arithmetic decoder exercise; not service asset clearance.
      expect(launchCreatedProblems(keyOf(log), event, event.parameters.quoteToken)).toEqual([]);
    }
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
      expect(launchCreatedProblems(key, mutated, event.parameters.quoteToken)).toContain(problem);
    }
    const [created] = createZeroSeedLaunchProcessors({ coreAddress: config.coreAddress, zeroSeedLaunchAddress: LAUNCH })
      .filter((p) => p.filter.topics[0] === LAUNCH_CREATED);
    const dao = { insertZeroSeedLaunchCreatedEvent: async () => { throw new Error("must not store"); } } as unknown as DAO;
    await expect(created!.handler(dao, { ...keyOf(log), emitter: config.coreAddress }, log)).rejects.toThrow(/Refusing LaunchCreated/);
  });

  it("refuses missing/wrong constructor quote and 32-byte multibyte metadata", () => {
    const log = createdLogs[0]!;
    const event = decodeCreated(log);
    expect(launchCreatedProblems(keyOf(log), event)).toContain("quoteToken is not the constructor-pinned quote");
    expect(launchCreatedProblems(keyOf(log), event, fixture.addresses.quote6)).toContain("quoteToken is not the constructor-pinned quote");
    for (const field of ["name", "symbol"] as const) {
      const withMetadata = (value: string) => ({ ...event, parameters: { ...event.parameters, [field]: value } });
      expect(launchCreatedProblems(keyOf(log), withMetadata("é".repeat(15) + "a"), event.parameters.quoteToken)).toEqual([]);
      expect(launchCreatedProblems(keyOf(log), withMetadata("é".repeat(16)), event.parameters.quoteToken)).toContain("metadata exceeds 31 UTF-8 bytes");
    }
  });
});
