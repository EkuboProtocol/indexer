import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeEventLog,
  encodeEventTopics,
  toEventSignature,
  toFunctionSelector,
  toFunctionSignature,
  toHex,
  zeroAddress,
  type AbiEvent,
  type AbiFunction,
} from "viem";
import type { DAO, ZeroSeedLaunchCreatedInsert } from "../_shared/dao";
import { CORE_ABI } from "./abis_v3";
import {
  ZERO_SEED_LAUNCH_ABI,
  ZERO_SEED_LAUNCH_ABI_SHA256,
  ZERO_SEED_LAUNCH_PERIPHERY_ABI,
  ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256,
} from "./abis_zero_seed_launch";
import {
  createLogProcessorsV3,
  type LogProcessorConfigV3,
} from "./logProcessorsV3";
import type { RawLog } from "./logStream";
import {
  resolveZeroSeedLaunchAddress,
  resolveZeroSeedLaunchPin,
  ZERO_SEED_LAUNCH_PINS,
  type ZeroSeedLaunchPin,
} from "./zeroSeedLaunchConfig";
import {
  createZeroSeedLaunchProcessors,
  launchCreatedProblems,
  zeroSeedLaunchCatchUpGuard,
} from "./zeroSeedLaunchProcessors";

/** Awaits `expect(promise).rejects.toThrow(error)`: bun-types declares the
 * matcher as returning void, but it returns a promise that must be awaited. */
const expectRejects = (promise: Promise<unknown>, error: RegExp) =>
  expect(promise).rejects.toThrow(error) as unknown as Promise<void>;

const FIXTURES = resolve(
  import.meta.dir,
  "../../tests/fixtures/zero-seed-launch",
);
const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8"));

type FixtureInstance = {
  label: string;
  extension: `0x${string}`;
  periphery: `0x${string}`;
  extensionRuntimeKeccak: `0x${string}`;
  peripheryRuntimeKeccak: `0x${string}`;
  extensionRuntimeTemplateKeccak: `0x${string}`;
  peripheryRuntimeTemplateKeccak: `0x${string}`;
  deploymentBlock: number;
};
type FixtureLaunch = {
  label: string;
  instance: string;
  poolId: `0x${string}`;
  token: `0x${string}`;
  quote: `0x${string}`;
  quoteKind: "native" | "erc20";
  tokenIsToken1: boolean;
  requestedSupply: string;
  installedSupply: string;
  sinkSupply: string;
  liquidity: string;
};
const fixture = readJson("local-chain.json") as {
  provenance: Record<string, string | boolean>;
  addresses: Record<string, `0x${string}`>;
  instances: FixtureInstance[];
  launches: Record<string, FixtureLaunch>;
  installations: Record<
    string,
    {
      requestedSupply: string;
      installedSupply: string;
      sinkSupply: string;
      liquidity: string;
      coreInstalledDelta: string;
      totalSupply: string;
      sinkBalance: string;
      tradingStart: number;
      owner: string;
      extensionSalt: string;
      predictedToken: string;
      installation: { installedSupply: string; liquidity: string };
    }
  >;
  forkPoint: number;
  branches: Record<
    "prefix" | "alternate" | "canonical",
    { logs: RawLog[]; blocks: { number: number }[] }
  >;
};
const [INSTANCE] = fixture.instances;

// The protocol's interface manifest of evm-contracts 40af6cb, vendored
// verbatim: generated from the build artifacts, not from this code.
const manifest = readJson("zero-seed-interface-40af6cb.json") as {
  manifest_sha256: string;
  frozen_commit: string;
  frozen_tree: string;
  artifacts: Record<
    "ZeroSeedLaunch" | "ZeroSeedLaunchPeriphery",
    {
      abi_sha256_canonical_json: string;
      runtime_template_keccak256_immutables_zero: string;
      creation_code_keccak256_no_constructor_args: string;
    }
  >;
  abi: Record<
    "ZeroSeedLaunch" | "ZeroSeedLaunchPeriphery",
    {
      functions: Record<string, `0x${string}`>;
      events: Record<string, `0x${string}`>;
      errors?: Record<string, `0x${string}`>;
    }
  >;
  supply: {
    examples: {
      order: "t0" | "t1";
      dec: string;
      requested: string;
      installed: string;
      liquidity: string;
      sink: string;
    }[];
  };
};

// The interface accepted for implementation: evm-contracts 40af6cb.
const FROZEN = {
  abiSha256: "999068f8e41867e972f4485c0105f584a2c10d7537615e6b4517807548fcd4bf",
  peripheryAbiSha256:
    "df24d9f07d45323da7e46c0f6e64ce24f8f522442d60cb07880ddf742ebe7305",
  evmContractsHead: "40af6cb359b0de2f61f15e47b6622a00c48b5b08",
  evmContractsTree: "f9925da3e2047b5ab5e45729056a3595043aa804",
  coreRuntimeKeccak:
    "0xc5f90c9d0dbc5037f8f9e248f4bb292e7c1824f584eb6550cb4cad525b38c71a",
  launchCreationKeccak:
    "0x78906a80dd0e4aeb1b7c94698a1e7917c20dc7b031a4513759ea12495f374384",
  peripheryCreationKeccak:
    "0xb36a0535c61c790f3600a0c45dd92763a1934652de322ddd1c175f3cda2dc046",
  launchRuntimeTemplate:
    "0x39a99e30dfff34873b7a820416ae4bc33a337612c644c45e68c51ac6564a9f4d",
  peripheryRuntimeTemplate:
    "0x08216f696368b4398afb8c43ca3eff0cccdcea00e71397178b78b2b94f957dbb",
  topics: {
    LaunchCreated:
      "0x3a4e811187f4a8c0b72396e9d7ca13aeed62eb97a599a24af1ed99066041098f",
    LaunchSwapped:
      "0x3e58795f52a8e88efdec2da89ea3798175f8764145ccd7bf5e40633a7d571f6d",
    CreatorFeesClaimed:
      "0xf0ffdfa84530baef2e9f8bbb160545a59bfef8da319fa27aa69e4f3c8f05a41d",
  },
  peripheryTopics: {
    LaunchOwnerChanged:
      "0x478004cf03e8c3b648608ce0259ce479c813aa671a383230ee7763fe5da22391",
    LaunchFeesClaimed:
      "0x908c6b2c19765fe47aef218b4f71ea1a10a9e156d9d5c3500c3a298e01428805",
  },
  selectors: {
    create: "0x662af306",
    previewInstallation: "0x917c1163",
    claimFees: "0x6906b4c0",
    transferLaunch: "0x8b1cb36f",
    launchOwner: "0x60ac0b66",
    LAUNCH: "0x096e3c3e",
    feeAt: "0xe81084ec",
    getLaunch: "0x7d1d589c",
    creatorFees: "0xb4ce9a2e",
  },
};

// `jq -cS`: keys sorted recursively, compact.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const config: LogProcessorConfigV3 = {
  mevCaptureAddress: "0x0000000000000000000000000000000000000001",
  boostedFeesConcentratedAddress: "0x0000000000000000000000000000000000000002",
  boostedFeesStableswapAddress: "0x0000000000000000000000000000000000000003",
  coreAddress: fixture.addresses.core,
  oracleAddress: "0x0000000000000000000000000000000000000005",
  incentivesAddress: "0x0000000000000000000000000000000000000006",
  tokenWrapperFactoryAddress: "0x0000000000000000000000000000000000000007",
  auctionsAddress: "0x0000000000000000000000000000000000000008",
  twammAddresses: [],
  ordersAddresses: [],
  positionsContracts: [],
};

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
const decodeCreated = (log: RawLog) => {
  const { args } = decodeEventLog({
    abi: ZERO_SEED_LAUNCH_ABI,
    eventName: "LaunchCreated",
    topics: log.topics as [`0x${string}`],
    data: log.data,
    strict: true,
  });
  if (!args) throw new Error("LaunchCreated log decoded without args");
  return args;
};
const launchOf = (poolId: string) =>
  Object.values(fixture.launches).find((l) => l.poolId === poolId)!;
const same = (a: string, b: string) => BigInt(a) === BigInt(b);

const abiItems = (abi: readonly unknown[]) =>
  abi as unknown as (
    | AbiFunction
    | AbiEvent
    | { type: string; name?: string }
  )[];

describe("frozen interface", () => {
  it("the compiled ABIs are the frozen ones, byte for byte", () => {
    expect(sha256(canonicalJson(ZERO_SEED_LAUNCH_ABI))).toBe(FROZEN.abiSha256);
    expect(sha256(canonicalJson(ZERO_SEED_LAUNCH_PERIPHERY_ABI))).toBe(
      FROZEN.peripheryAbiSha256,
    );
    expect(ZERO_SEED_LAUNCH_ABI_SHA256).toBe(FROZEN.abiSha256);
    expect(ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256).toBe(
      FROZEN.peripheryAbiSha256,
    );
    for (const [eventName, topic] of Object.entries(FROZEN.topics))
      expect(
        encodeEventTopics({
          abi: ZERO_SEED_LAUNCH_ABI,
          eventName: eventName as "LaunchCreated",
        })[0],
      ).toBe(topic as `0x${string}`);
    for (const [eventName, topic] of Object.entries(FROZEN.peripheryTopics))
      expect(
        encodeEventTopics({
          abi: ZERO_SEED_LAUNCH_PERIPHERY_ABI,
          eventName: eventName as "LaunchOwnerChanged",
        })[0],
      ).toBe(topic as `0x${string}`);
    const items = abiItems([
      ...ZERO_SEED_LAUNCH_ABI,
      ...ZERO_SEED_LAUNCH_PERIPHERY_ABI,
    ]);
    const functions = items.filter(
      (item): item is AbiFunction => item.type === "function",
    );
    for (const [name, selector] of Object.entries(FROZEN.selectors))
      expect(
        functions
          .filter((f) => f.name === name)
          .map((f) => toFunctionSelector(f) as string),
      ).toContain(selector);
    // The constructor quote, its getter and the exact-supply error are gone.
    expect(functions.some((f) => f.name === "quoteToken")).toBe(false);
    expect(
      items.some(
        (i) => i.type === "error" && i.name === "SupplyNotExactlyInstallable",
      ),
    ).toBe(false);
    const constructor = items.find(
      (i) => i.type === "constructor",
    ) as unknown as {
      inputs: { name: string }[];
    };
    expect(constructor.inputs.map((i) => i.name)).toEqual(["core"]);
    // LaunchParameters: quoteToken replaced liquidity.
    const created = items.find(
      (item): item is AbiEvent =>
        item.type === "event" && item.name === "LaunchCreated",
    )!;
    const parameters = created.inputs.find(
      (i) => i.name === "parameters",
    ) as unknown as { components: { name: string; type: string }[] };
    expect(parameters.components.map((c) => `${c.type} ${c.name}`)).toEqual([
      "string name",
      "string symbol",
      "uint8 decimals",
      "uint128 supply",
      "address quoteToken",
      "int32 askTick",
      "int32 upperTick",
      "uint32 tickSpacing",
      "uint64 tradingStart",
      "uint32 feeDuration",
      "uint64 initialFee",
      "uint64 finalFee",
      "bytes32 salt",
    ]);
  });

  it("every function, event and error equals the vendored protocol manifest", () => {
    expect([manifest.frozen_commit, manifest.frozen_tree]).toEqual([
      FROZEN.evmContractsHead,
      FROZEN.evmContractsTree,
    ]);
    for (const [name, abi, hash] of [
      ["ZeroSeedLaunch", ZERO_SEED_LAUNCH_ABI, FROZEN.abiSha256],
      [
        "ZeroSeedLaunchPeriphery",
        ZERO_SEED_LAUNCH_PERIPHERY_ABI,
        FROZEN.peripheryAbiSha256,
      ],
    ] as const) {
      const artifact = manifest.artifacts[name];
      expect(artifact.abi_sha256_canonical_json).toBe(hash);
      const items = abiItems(abi);
      const functions = Object.fromEntries(
        items
          .filter((i): i is AbiFunction => i.type === "function")
          .map((f) => [
            toFunctionSignature(f).replaceAll(" ", ""),
            toFunctionSelector(f),
          ]),
      );
      const events = Object.fromEntries(
        items
          .filter((i): i is AbiEvent => i.type === "event")
          .map((e) => [
            toEventSignature(e).replaceAll(" ", ""),
            encodeEventTopics({ abi: [e] })[0],
          ]),
      );
      expect(functions).toEqual(manifest.abi[name].functions);
      expect(events).toEqual(manifest.abi[name].events);
    }
    expect([
      manifest.artifacts.ZeroSeedLaunch
        .creation_code_keccak256_no_constructor_args,
      manifest.artifacts.ZeroSeedLaunchPeriphery
        .creation_code_keccak256_no_constructor_args,
      manifest.artifacts.ZeroSeedLaunch
        .runtime_template_keccak256_immutables_zero,
      manifest.artifacts.ZeroSeedLaunchPeriphery
        .runtime_template_keccak256_immutables_zero,
    ]).toEqual([
      FROZEN.launchCreationKeccak,
      FROZEN.peripheryCreationKeccak,
      FROZEN.launchRuntimeTemplate,
      FROZEN.peripheryRuntimeTemplate,
    ]);
  });

  it("the replay fixture came from the frozen contracts head over the pinned Core runtime", () => {
    const p = fixture.provenance;
    expect([
      p.evmContractsHead,
      p.evmContractsTree,
      p.evmContractsDirty,
    ]).toEqual([FROZEN.evmContractsHead, FROZEN.evmContractsTree, false]);
    expect([
      p.coreRuntimeKeccak,
      p.launchAbiSha256,
      p.peripheryAbiSha256,
      p.launchCreationKeccak,
      p.peripheryCreationKeccak,
      p.launchRuntimeTemplateKeccak,
      p.peripheryRuntimeTemplateKeccak,
      INSTANCE.extensionRuntimeTemplateKeccak,
      INSTANCE.peripheryRuntimeTemplateKeccak,
    ]).toEqual([
      FROZEN.coreRuntimeKeccak,
      FROZEN.abiSha256,
      FROZEN.peripheryAbiSha256,
      FROZEN.launchCreationKeccak,
      FROZEN.peripheryCreationKeccak,
      FROZEN.launchRuntimeTemplate,
      FROZEN.peripheryRuntimeTemplate,
      FROZEN.launchRuntimeTemplate,
      FROZEN.peripheryRuntimeTemplate,
    ]);
    expect(fixture.instances).toHaveLength(1);
    expect(createdLogs.length).toBe(4);
    expect(fixture.forkPoint).toBe(
      Math.max(...fixture.branches.prefix.blocks.map((b) => b.number)),
    );
    for (const branch of [
      fixture.branches.alternate,
      fixture.branches.canonical,
    ])
      expect(
        branch.logs.every((l) => Number(l.blockNumber) > fixture.forkPoint),
      ).toBe(true);
    // The instance and its first launch share the deployment block.
    const l1 = createdLogs.find(
      (l) => decodeCreated(l).poolId === fixture.launches.l1.poolId,
    )!;
    expect(Number(l1.blockNumber)).toBe(INSTANCE.deploymentBlock);
  });

  it("every launch submitted the requested supply and recorded installed and sink supply exactly", () => {
    const kinds = new Set<string>();
    for (const log of createdLogs) {
      const event = decodeCreated(log);
      const launch = launchOf(event.poolId);
      const installation = fixture.installations[launch.label];
      kinds.add(launch.quoteKind);
      // one extension serves every quote
      expect(log.address.toLowerCase()).toBe(INSTANCE.extension.toLowerCase());
      expect([
        String(event.parameters.supply),
        event.parameters.quoteToken.toLowerCase(),
        String(event.liquidity),
        Number(event.parameters.tradingStart),
        event.parameters.salt,
        event.token,
        event.controller.toLowerCase(),
      ]).toEqual([
        launch.requestedSupply,
        launch.quote.toLowerCase(),
        launch.liquidity,
        installation.tradingStart,
        installation.extensionSalt as `0x${string}`,
        installation.predictedToken as `0x${string}`,
        INSTANCE.periphery.toLowerCase(),
      ]);
      const requested = BigInt(launch.requestedSupply);
      const installed = BigInt(launch.installedSupply);
      expect(requested).toBe(10n ** 27n);
      expect(installed > 0n && installed <= requested).toBe(true);
      expect(BigInt(launch.sinkSupply)).toBe(requested - installed);
      // the chain's own evidence, recorded by the generator
      expect([
        installation.coreInstalledDelta,
        installation.installation.installedSupply,
        installation.installation.liquidity,
        installation.totalSupply,
        installation.sinkBalance,
      ]).toEqual([
        launch.installedSupply,
        launch.installedSupply,
        launch.liquidity,
        launch.requestedSupply,
        launch.sinkSupply,
      ]);
      // the protocol's independent 18/18 vectors for this token order
      const vector = manifest.supply.examples.find(
        (e) =>
          e.dec === "18/18" && e.order === (launch.tokenIsToken1 ? "t1" : "t0"),
      )!;
      expect([
        launch.requestedSupply,
        launch.installedSupply,
        launch.liquidity,
        launch.sinkSupply,
      ]).toEqual([
        vector.requested,
        vector.installed,
        vector.liquidity,
        vector.sink,
      ]);
    }
    expect([...kinds].sort()).toEqual(["erc20", "native"]);
  });
});

describe("launch support configuration", () => {
  const base = {
    chainId: 31337n,
    address: INSTANCE.extension,
    runtimeCodehash: INSTANCE.extensionRuntimeKeccak,
    coreAddress: fixture.addresses.core,
    production: false,
  };
  const [PIN] = ZERO_SEED_LAUNCH_PINS;
  const otherChainPin: ZeroSeedLaunchPin = {
    ...PIN,
    chainId: 8453n,
    local: false,
  };

  it("only the local fixture instance is pinned, with no quote; no live pin exists", () => {
    expect(ZERO_SEED_LAUNCH_PINS).toHaveLength(1);
    expect({
      address: PIN.address,
      runtime: PIN.runtimeCodehash,
      periphery: PIN.periphery,
      peripheryRuntime: PIN.peripheryRuntimeCodehash,
      core: PIN.core,
      deploymentBlock: PIN.deploymentBlock,
      chainId: PIN.chainId,
      local: PIN.local,
    }).toEqual({
      address: INSTANCE.extension.toLowerCase() as `0x${string}`,
      runtime: INSTANCE.extensionRuntimeKeccak,
      periphery: INSTANCE.periphery.toLowerCase() as `0x${string}`,
      peripheryRuntime: INSTANCE.peripheryRuntimeKeccak,
      core: fixture.addresses.core.toLowerCase() as `0x${string}`,
      deploymentBlock: INSTANCE.deploymentBlock,
      chainId: 31337n,
      local: true,
    });
    expect("quote" in PIN).toBe(false);
    expect(() =>
      createZeroSeedLaunchProcessors({
        coreAddress: fixture.addresses.core,
        zeroSeedLaunchAddresses: [INSTANCE.periphery],
      }),
    ).toThrow(/provenance/);
  });

  it("is on only for a pinned address and codehash, and resolves its periphery from the pin", () => {
    const pin = resolveZeroSeedLaunchPin(base)!;
    expect([pin.address, pin.periphery]).toEqual([
      INSTANCE.extension.toLowerCase() as `0x${string}`,
      INSTANCE.periphery.toLowerCase() as `0x${string}`,
    ]);
    expect(resolveZeroSeedLaunchAddress(base)).toBe(
      INSTANCE.extension.toLowerCase() as `0x${string}`,
    );
  });

  it("is off when the address, codehash, chain id or the chain's pin is missing", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(
      resolveZeroSeedLaunchAddress({ ...base, address: undefined, warn }),
    ).toBeUndefined();
    expect(
      resolveZeroSeedLaunchAddress({
        ...base,
        runtimeCodehash: undefined,
        warn,
      }),
    ).toBeUndefined();
    expect(
      resolveZeroSeedLaunchAddress({ ...base, chainId: undefined, warn }),
    ).toBeUndefined();
    expect(
      resolveZeroSeedLaunchAddress({ ...base, chainId: 8453n, warn }),
    ).toBeUndefined();
    expect(warnings).toHaveLength(3);
  });

  it("refuses to start on a mismatch, a template codehash, a local pin in production or another ABI", () => {
    expect(() =>
      resolveZeroSeedLaunchAddress({
        ...base,
        address: "0x5eed00000000000000000000000000000000ab01",
      }),
    ).toThrow(/not a pinned launch/);
    expect(() =>
      resolveZeroSeedLaunchAddress({
        ...base,
        runtimeCodehash: INSTANCE.peripheryRuntimeKeccak,
      }),
    ).toThrow(/does not match the pin/);
    // The zero-filled templates of the extension and periphery builds.
    for (const template of [
      FROZEN.launchRuntimeTemplate,
      FROZEN.peripheryRuntimeTemplate,
    ] as const)
      expect(() =>
        resolveZeroSeedLaunchAddress({
          ...base,
          runtimeCodehash: template as `0x${string}`,
        }),
      ).toThrow(/not a deployed runtime/);
    expect(() =>
      resolveZeroSeedLaunchAddress({
        ...base,
        runtimeCodehash: toHex(0n, { size: 32 }),
      }),
    ).toThrow(/not a deployed runtime/);
    expect(() =>
      resolveZeroSeedLaunchAddress({ ...base, production: true }),
    ).toThrow(/local fixture/);
    expect(() =>
      resolveZeroSeedLaunchAddress({
        ...base,
        chainId: 8453n,
        pins: [{ ...otherChainPin, abiSha256: "00" }],
      }),
    ).toThrow(/ABI/);
    expect(() =>
      resolveZeroSeedLaunchAddress({
        ...base,
        chainId: 8453n,
        pins: [{ ...otherChainPin, peripheryAbiSha256: "00" }],
      }),
    ).toThrow(/ABI/);
    expect(() =>
      resolveZeroSeedLaunchAddress({
        ...base,
        pins: [
          {
            ...PIN,
            peripheryRuntimeCodehash:
              FROZEN.peripheryRuntimeTemplate as `0x${string}`,
          },
        ],
      }),
    ).toThrow(/no deployed periphery/);
    expect(() =>
      resolveZeroSeedLaunchAddress({ ...base, coreAddress: undefined }),
    ).toThrow(/Core/);
    expect(() =>
      resolveZeroSeedLaunchAddress({
        ...base,
        coreAddress: "0x0000000000000000000000000000000000000001",
      }),
    ).toThrow(/Core/);
  });

  it("refuses a reviewed address with another periphery, runtime, Core or deployment block", () => {
    for (const changed of [
      { periphery: "0x5eed00000000000000000000000000000000ab02" },
      { peripheryRuntimeCodehash: toHex(1n, { size: 32 }) },
      { deploymentBlock: 1 },
      { core: "0x0000000000000000000000000000000000000001", local: true },
    ] as Partial<ZeroSeedLaunchPin>[]) {
      const pin = { ...PIN, ...changed };
      expect(() =>
        resolveZeroSeedLaunchAddress({
          ...base,
          coreAddress: pin.core,
          pins: [pin],
        }),
      ).toThrow(/not reviewed/);
    }
  });
});

describe("processors", () => {
  const launchTopics = (addresses: readonly `0x${string}`[] | undefined) =>
    createLogProcessorsV3({ ...config, zeroSeedLaunchAddresses: addresses })
      .filter((p) =>
        [INSTANCE.extension, INSTANCE.periphery].some(
          (a) => a.toLowerCase() === p.address.toLowerCase(),
        ),
      )
      .map((p) => [p.address.toLowerCase(), p.filter.topics[0]]);

  it("decode exactly the five frozen events of the instance's extension and periphery, and nothing without an address", () => {
    expect(launchTopics([INSTANCE.extension]).sort()).toEqual(
      [
        ...Object.values(FROZEN.topics).map((t) => [
          INSTANCE.extension.toLowerCase(),
          t,
        ]),
        ...Object.values(FROZEN.peripheryTopics).map((t) => [
          INSTANCE.periphery.toLowerCase(),
          t,
        ]),
      ].sort(),
    );
    expect(launchTopics(undefined)).toEqual([]);
    expect(launchTopics([])).toEqual([]);
  });

  it("register every launch pool at PoolInitialized, whatever its quote, only when support is on", async () => {
    const poolInitialized = allLogs.filter(
      (l) =>
        l.topics[0] ===
        encodeEventTopics({ abi: CORE_ABI, eventName: "PoolInitialized" })[0],
    );
    expect(poolInitialized).toHaveLength(4);
    for (const [addresses, expected] of [
      [[INSTANCE.extension], 4],
      [[], 0],
      [undefined, 0],
    ] as const) {
      const registered: string[] = [];
      const dao = {
        insertPoolInitializedEvent: async () => {},
        insertMEVCapturePoolKey: async () => {},
        insertZeroSeedLaunchPoolKey: async (_core: string, poolId: string) =>
          void registered.push(poolId),
      } as unknown as DAO;
      const processors = createLogProcessorsV3({
        ...config,
        zeroSeedLaunchAddresses: addresses,
      });
      const core = processors.find(
        (p) =>
          p.address === config.coreAddress &&
          p.filter.topics[0] === poolInitialized[0].topics[0],
      )!;
      for (const log of poolInitialized)
        await core.handler(dao, keyOf(log), log);
      expect(registered).toHaveLength(expected);
    }
  });

  it("the catch-up guard asks once, only for pinned instances, with the first indexed block", async () => {
    const calls: unknown[][] = [];
    const dao = {
      zeroSeedLaunchCatchUpProblem: async (...args: unknown[]) => {
        calls.push(args);
        return calls.length === 1 ? "missed" : undefined;
      },
    } as unknown as DAO;
    const guard = zeroSeedLaunchCatchUpGuard([ZERO_SEED_LAUNCH_PINS[0]]);
    await expectRejects(guard(dao, 3), /missed/);
    await guard(dao, 3);
    await guard(dao, 4);
    expect(calls).toEqual([
      [ZERO_SEED_LAUNCH_PINS[0].core, INSTANCE.extension.toLowerCase(), 2, 3],
      [ZERO_SEED_LAUNCH_PINS[0].core, INSTANCE.extension.toLowerCase(), 2, 3],
    ]);
    await zeroSeedLaunchCatchUpGuard([])(
      {
        zeroSeedLaunchCatchUpProblem: () => {
          throw new Error("must not ask");
        },
      } as unknown as DAO,
      1,
    );
  });
});

describe("LaunchCreated decoding", () => {
  const createdProcessor = createZeroSeedLaunchProcessors({
    coreAddress: config.coreAddress,
    zeroSeedLaunchAddresses: [INSTANCE.extension],
  }).find((p) => p.filter.topics[0] === LAUNCH_CREATED)!;

  it("decodes every raw chain log into the launch's own quote, requested supply and computed liquidity", async () => {
    const stored: ZeroSeedLaunchCreatedInsert[] = [];
    const dao = {
      insertZeroSeedLaunchCreatedEvent: async (
        _key: unknown,
        row: ZeroSeedLaunchCreatedInsert,
      ) => void stored.push(row),
    } as unknown as DAO;
    for (const log of createdLogs)
      await createdProcessor.handler(dao, keyOf(log), log);
    expect(
      stored.map((row) => ({
        poolId: row.poolId,
        quote: (row.quoteToken as string).toLowerCase(),
        requested: String(row.requestedSupply),
        liquidity: String(row.liquidity),
        token: row.token,
        tokenIsToken1: BigInt(row.token) > BigInt(row.quoteToken),
      })),
    ).toEqual(
      createdLogs.map((log) => {
        const launch = launchOf(decodeCreated(log).poolId);
        return {
          poolId: launch.poolId,
          quote: launch.quote.toLowerCase(),
          requested: launch.requestedSupply,
          liquidity: launch.liquidity,
          token: launch.token,
          tokenIsToken1: launch.tokenIsToken1,
        };
      }),
    );
    // the installed supply is not in the log; the DAO takes it from Core
    expect(stored.every((row) => !("installedSupply" in row))).toBe(true);
  });

  it("accepts every chain-emitted LaunchCreated, native and ERC-20, on one extension", () => {
    for (const log of createdLogs) {
      const event = decodeCreated(log);
      const launch = launchOf(event.poolId);
      expect(launchCreatedProblems(keyOf(log), event)).toEqual([]);
      // native ETH is always token0, so the launch token is token1; the
      // relocated ERC-20 at 0xff..ff is always token1
      if (launch.quoteKind === "native")
        expect([event.poolKey.token0, launch.tokenIsToken1]).toEqual([
          zeroAddress,
          true,
        ]);
      else
        expect([
          same(event.poolKey.token1, fixture.addresses.erc20Quote),
          launch.tokenIsToken1,
        ]).toEqual([true, false]);
    }
  });

  it("refuses logs whose fields disagree, and the handler stores nothing", async () => {
    for (const log of createdLogs) {
      const event = decodeCreated(log);
      const withParameters = (p: Partial<typeof event.parameters>) => ({
        ...event,
        parameters: { ...event.parameters, ...p },
      });
      const otherQuote =
        BigInt(event.parameters.quoteToken) === 0n
          ? fixture.addresses.erc20Quote
          : zeroAddress;
      const mutants: [string, typeof event, string][] = [
        [
          "quote/pool key mismatch",
          withParameters({ quoteToken: otherQuote }),
          "pool tokens are not (token, quoteToken) in order",
        ],
        [
          "quote is another ERC-20",
          withParameters({
            quoteToken: "0x5eed00000000000000000000000000000000ab01",
          }),
          "pool tokens are not (token, quoteToken) in order",
        ],
        [
          "token is the quote",
          withParameters({ quoteToken: event.token }),
          "launch token is the quote",
        ],
        ["emitter", event, "pool extension is not the emitter"],
        [
          "poolId",
          { ...event, poolId: toHex(1n, { size: 32 }) },
          "poolId != id of poolKey",
        ],
        [
          "order",
          {
            ...event,
            poolKey: {
              ...event.poolKey,
              token0: event.poolKey.token1,
              token1: event.poolKey.token0,
            },
          },
          "pool tokens are not (token, quoteToken) in order",
        ],
        [
          "position salt",
          {
            ...event,
            positionId: toHex(BigInt(event.positionId) | (1n << 64n), {
              size: 32,
            }),
          },
          "position is not (salt 0, tick_lower, tick_upper)",
        ],
        [
          "position bounds",
          {
            ...event,
            positionId: toHex(BigInt(event.positionId) + 1n, { size: 32 }),
          },
          "position is not (salt 0, tick_lower, tick_upper)",
        ],
        [
          "economic ticks",
          withParameters({ askTick: event.parameters.askTick + 100 }),
          "position is not (salt 0, tick_lower, tick_upper)",
        ],
        [
          "fee",
          {
            ...event,
            poolKey: {
              ...event.poolKey,
              config: toHex(BigInt(event.poolKey.config) | (1n << 64n), {
                size: 32,
              }),
            },
          },
          "Core fee is not 0",
        ],
        [
          "spacing",
          withParameters({ tickSpacing: event.parameters.tickSpacing + 1 }),
          "tick spacing differs",
        ],
        ["liquidity", { ...event, liquidity: 0n }, "liquidity is 0"],
        [
          "zero supply",
          withParameters({ supply: 0n }),
          "requested supply is outside 1..int128.max",
        ],
        [
          "supply above int128",
          withParameters({ supply: 1n << 127n }),
          "requested supply is outside 1..int128.max",
        ],
      ];
      for (const [name, mutated, problem] of mutants) {
        const key =
          name === "emitter"
            ? { ...keyOf(log), emitter: config.coreAddress }
            : keyOf(log);
        expect(launchCreatedProblems(key, mutated), name).toContain(problem);
      }
      expect(
        launchCreatedProblems(
          keyOf(log),
          withParameters({ supply: (1n << 127n) - 1n }),
        ),
      ).toEqual([]);
    }
    const [log] = createdLogs;
    const dao = {
      insertZeroSeedLaunchCreatedEvent: async () => {
        throw new Error("must not store");
      },
    } as unknown as DAO;
    await expectRejects(
      createdProcessor.handler(
        dao,
        { ...keyOf(log), emitter: config.coreAddress },
        log,
      ),
      /Refusing LaunchCreated/,
    );
  });

  it("refuses 32-byte multibyte metadata", () => {
    const [log] = createdLogs;
    const event = decodeCreated(log);
    for (const field of ["name", "symbol"] as const) {
      const withMetadata = (value: string) => ({
        ...event,
        parameters: { ...event.parameters, [field]: value },
      });
      expect(
        launchCreatedProblems(keyOf(log), withMetadata("é".repeat(15) + "a")),
      ).toEqual([]);
      expect(
        launchCreatedProblems(keyOf(log), withMetadata("é".repeat(16))),
      ).toContain("metadata exceeds 31 UTF-8 bytes");
    }
  });
});
