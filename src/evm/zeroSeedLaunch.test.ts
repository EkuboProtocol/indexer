import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeEventLog,
  encodeEventTopics,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type AbiFunction,
  type AbiEvent,
} from "viem";
import type { DAO } from "../_shared/dao";
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

type FixtureInstance = {
  label: string;
  quote: `0x${string}`;
  quoteKind: "native" | "erc20";
  extension: `0x${string}`;
  periphery: `0x${string}`;
  extensionRuntimeKeccak: `0x${string}`;
  peripheryRuntimeKeccak: `0x${string}`;
  quoteRuntimeKeccak: `0x${string}` | null;
  deploymentBlock: number;
};
const fixture = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dir,
      "../../tests/fixtures/zero-seed-launch/local-chain.json",
    ),
    "utf8",
  ),
) as {
  provenance: Record<string, string | boolean>;
  addresses: Record<string, `0x${string}`>;
  instances: FixtureInstance[];
  launches: Record<
    string,
    { label: string; instance: string; poolId: string; token: string }
  >;
  installations: Record<
    string,
    {
      actualInstalledSupply: string;
      actualLiquidity: string;
      tradingStart: number;
      requestedSupply: string;
      owner: string;
      extensionSalt: string;
      predictedToken: string;
    }
  >;
  forkPoint: number;
  branches: Record<
    "prefix" | "alternate" | "canonical",
    { logs: RawLog[]; blocks: { number: number }[] }
  >;
};
const NATIVE = fixture.instances.find((i) => i.label === "native")!;
const WETH = fixture.instances.find((i) => i.label === "weth")!;

// The interface accepted for implementation: evm-contracts 4f1a3060, whose
// protocol manifest lists these hashes, topics and selectors.
const FROZEN = {
  abiSha256: "21f9e2c0166ab28ce8573c481de5b0fc2f37dd7595d496d326f0a2d1a544254e",
  peripheryAbiSha256:
    "5c563488b843aee923d0d819a66489eeee543dd20d1582de1f5df643f5d08a75",
  evmContractsHead: "4f1a3060b099e8a50469848118f44c0c65cfab9a",
  evmContractsTree: "64649a281f113674584f192ff11b642071fdeac3",
  coreRuntimeKeccak:
    "0xc5f90c9d0dbc5037f8f9e248f4bb292e7c1824f584eb6550cb4cad525b38c71a",
  routerRuntimeKeccak:
    "0x32ba8475c95ee5d9f7807f4ad9dce849929c992df9c68e9030e986d1854e726f",
  launchCreationKeccak:
    "0x50dc9c4148f4c81f8f689a2b62ed70c9590366fdb963072b4f2b89361f1dcd7c",
  peripheryCreationKeccak:
    "0x79a8ef83d84f8110f6fec96a2d964a39913f81ab23a304fb19fb577fe29ef56c",
  topics: {
    LaunchCreated:
      "0x085ada2e6f98dc43ec420caff7f39c25cbc16c81595684b19c4fca014dae5f2d",
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
    create: "0x687ba810",
    previewInstallation: "0x42b9fe08",
    claimFees: "0x6906b4c0",
    transferLaunch: "0x8b1cb36f",
    launchOwner: "0x60ac0b66",
    feeAt: "0xe81084ec",
    getLaunch: "0x7d1d589c",
    creatorFees: "0xb4ce9a2e",
    quoteToken: "0x217a4b70",
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
const instanceOf = (emitter: string) =>
  fixture.instances.find(
    (i) => i.extension.toLowerCase() === emitter.toLowerCase(),
  )!;

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
    const items = [
      ...ZERO_SEED_LAUNCH_ABI,
      ...ZERO_SEED_LAUNCH_PERIPHERY_ABI,
    ] as unknown as (AbiFunction | AbiEvent | { type: string })[];
    const functions = items.filter(
      (item): item is AbiFunction => item.type === "function",
    );
    for (const [name, selector] of Object.entries(FROZEN.selectors))
      expect(
        functions
          .filter((f) => f.name === name)
          .map((f) => toFunctionSelector(f) as string),
      ).toContain(selector);
    // LaunchParameters lost quoteToken and decayFactor.
    const created = items.find(
      (item): item is AbiEvent =>
        item.type === "event" && (item as AbiEvent).name === "LaunchCreated",
    )!;
    const parameters = created.inputs.find(
      (i) => i.name === "parameters",
    ) as unknown as { components: { name: string }[] };
    expect(parameters.components.map((c) => c.name)).toEqual([
      "name",
      "symbol",
      "decimals",
      "supply",
      "liquidity",
      "askTick",
      "upperTick",
      "tickSpacing",
      "tradingStart",
      "feeDuration",
      "initialFee",
      "finalFee",
      "salt",
    ]);
  });

  it("the replay fixture came from the frozen contracts head over the pinned Core and router runtimes", () => {
    const p = fixture.provenance;
    expect([
      p.evmContractsHead,
      p.evmContractsTree,
      p.evmContractsDirty,
    ]).toEqual([FROZEN.evmContractsHead, FROZEN.evmContractsTree, false]);
    expect([
      p.coreRuntimeKeccak,
      p.routerRuntimeKeccak,
      p.launchAbiSha256,
      p.peripheryAbiSha256,
      p.launchCreationKeccak,
      p.peripheryCreationKeccak,
    ]).toEqual([
      FROZEN.coreRuntimeKeccak,
      FROZEN.routerRuntimeKeccak,
      FROZEN.abiSha256,
      FROZEN.peripheryAbiSha256,
      FROZEN.launchCreationKeccak,
      FROZEN.peripheryCreationKeccak,
    ]);
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
    for (const log of createdLogs) {
      const event = decodeCreated(log);
      const launch = Object.values(fixture.launches).find(
        (l) => l.poolId === event.poolId,
      )!;
      const installation = fixture.installations[launch.label];
      const instance = instanceOf(log.address);
      expect([
        String(event.parameters.supply),
        String(event.liquidity),
        Number(event.parameters.tradingStart),
        event.parameters.salt,
        event.token,
        event.controller.toLowerCase(),
      ]).toEqual([
        installation.actualInstalledSupply,
        installation.actualLiquidity,
        installation.tradingStart,
        installation.extensionSalt as `0x${string}`,
        installation.predictedToken as `0x${string}`,
        instance.periphery.toLowerCase() as `0x${string}`,
      ]);
      expect(
        BigInt(installation.requestedSupply) >= event.parameters.supply,
      ).toBe(true);
    }
    // The native instance and its first launch share the deployment block.
    const l1 = createdLogs.find(
      (l) => decodeCreated(l).poolId === fixture.launches.l1.poolId,
    )!;
    expect(Number(l1.blockNumber)).toBe(NATIVE.deploymentBlock);
  });
});

describe("launch support configuration", () => {
  const base = {
    chainId: 31337n,
    address: NATIVE.extension,
    runtimeCodehash: NATIVE.extensionRuntimeKeccak,
    coreAddress: fixture.addresses.core,
    production: false,
  };
  const otherChainPin: ZeroSeedLaunchPin = {
    ...ZERO_SEED_LAUNCH_PINS[0],
    chainId: 8453n,
    local: false,
  };

  it("only the native and plain-WETH local fixture instances are pinned; no live pin exists", () => {
    expect(ZERO_SEED_LAUNCH_PINS).toHaveLength(2);
    for (const pin of ZERO_SEED_LAUNCH_PINS) {
      const instance = instanceOf(pin.address);
      expect({
        quote: pin.quote.address,
        kind: pin.quote.kind,
        quoteRuntime:
          pin.quote.kind === "erc20" ? pin.quote.runtimeCodehash : null,
        runtime: pin.runtimeCodehash,
        periphery: pin.periphery,
        peripheryRuntime: pin.peripheryRuntimeCodehash,
        deploymentBlock: pin.deploymentBlock,
        chainId: pin.chainId,
        local: pin.local,
      }).toEqual({
        quote: instance.quote.toLowerCase() as `0x${string}`,
        kind: instance.quoteKind,
        quoteRuntime: instance.quoteRuntimeKeccak,
        runtime: instance.extensionRuntimeKeccak,
        periphery: instance.periphery.toLowerCase() as `0x${string}`,
        peripheryRuntime: instance.peripheryRuntimeKeccak,
        deploymentBlock: instance.deploymentBlock,
        chainId: 31337n,
        local: true,
      });
    }
    expect(NATIVE.quote).toBe(zeroAddress);
    expect(NATIVE.quoteRuntimeKeccak).toBeNull();
    expect(() =>
      createZeroSeedLaunchProcessors({
        coreAddress: fixture.addresses.core,
        zeroSeedLaunchAddresses: [NATIVE.periphery],
      }),
    ).toThrow(/provenance/);
  });

  it("is on only for a pinned address and codehash, and resolves its periphery from the pin", () => {
    for (const instance of [NATIVE, WETH]) {
      const pin = resolveZeroSeedLaunchPin({
        ...base,
        address: instance.extension,
        runtimeCodehash: instance.extensionRuntimeKeccak,
      })!;
      expect([pin.address, pin.periphery]).toEqual([
        instance.extension.toLowerCase() as `0x${string}`,
        instance.periphery.toLowerCase() as `0x${string}`,
      ]);
    }
    expect(resolveZeroSeedLaunchAddress(base)).toBe(
      NATIVE.extension.toLowerCase() as `0x${string}`,
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
        runtimeCodehash: WETH.extensionRuntimeKeccak,
      }),
    ).toThrow(/does not match the pin/);
    // The zero-filled templates of the extension and periphery builds.
    for (const template of [
      "0x25637ad2d1071b641f275d3b1037616b8836d2445501c05d38618764fa924167",
      "0x271683d2c3cf5e518fc5aa531f8568191b166a262a43e05d13325f0630dd5d7a",
    ] as const)
      expect(() =>
        resolveZeroSeedLaunchAddress({ ...base, runtimeCodehash: template }),
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
      resolveZeroSeedLaunchAddress({ ...base, coreAddress: undefined }),
    ).toThrow(/Core/);
    expect(() =>
      resolveZeroSeedLaunchAddress({
        ...base,
        coreAddress: "0x0000000000000000000000000000000000000001",
      }),
    ).toThrow(/Core/);
  });

  it("keeps native and ERC-20 quote provenance distinct", () => {
    const native = ZERO_SEED_LAUNCH_PINS[0];
    const weth = ZERO_SEED_LAUNCH_PINS[1];
    const reject = (pin: ZeroSeedLaunchPin, error: RegExp) =>
      expect(() =>
        resolveZeroSeedLaunchAddress({
          ...base,
          address: pin.address,
          runtimeCodehash: pin.runtimeCodehash,
          pins: [pin],
        }),
      ).toThrow(error);
    // a native quote is address(0), with no runtime to bind
    reject(
      {
        ...native,
        quote: {
          kind: "native",
          address: weth.quote
            .address as "0x0000000000000000000000000000000000000000",
        },
      },
      /native quote must be address\(0\)/,
    );
    // address(0) relabelled as an ERC-20, or an ERC-20 of another runtime
    reject(
      {
        ...native,
        quote: {
          kind: "erc20",
          address: zeroAddress,
          runtimeCodehash: FROZEN.coreRuntimeKeccak as `0x${string}`,
        },
      },
      /ERC-20 quote cannot be address\(0\)/,
    );
    reject(
      {
        ...native,
        address: weth.address,
        runtimeCodehash: weth.runtimeCodehash,
        quote: {
          kind: "erc20",
          address: weth.quote.address,
          runtimeCodehash: toHex(1n, { size: 32 }),
        },
      },
      /plain-WETH runtime/,
    );
    // a reviewed address with another periphery, quote or deployment block
    for (const changed of [
      { periphery: weth.periphery },
      { peripheryRuntimeCodehash: weth.peripheryRuntimeCodehash },
      { quote: weth.quote },
      { deploymentBlock: 1 },
    ])
      reject({ ...native, ...changed }, /not reviewed/);
  });
});

describe("processors", () => {
  const launchTopics = (addresses: readonly `0x${string}`[] | undefined) =>
    createLogProcessorsV3({ ...config, zeroSeedLaunchAddresses: addresses })
      .filter((p) =>
        [NATIVE.extension, NATIVE.periphery].some(
          (a) => a.toLowerCase() === p.address.toLowerCase(),
        ),
      )
      .map((p) => [p.address.toLowerCase(), p.filter.topics[0]]);

  it("decode exactly the five frozen events of the instance's extension and periphery, and nothing without an address", () => {
    expect(launchTopics([NATIVE.extension]).sort()).toEqual(
      [
        ...Object.values(FROZEN.topics).map((t) => [
          NATIVE.extension.toLowerCase(),
          t,
        ]),
        ...Object.values(FROZEN.peripheryTopics).map((t) => [
          NATIVE.periphery.toLowerCase(),
          t,
        ]),
      ].sort(),
    );
    expect(launchTopics(undefined)).toEqual([]);
    expect(launchTopics([])).toEqual([]);
  });

  it("register a launch pool at PoolInitialized only when support is on", async () => {
    const poolInitialized = fixture.branches.prefix.logs.find(
      (l) =>
        l.topics[0] ===
        encodeEventTopics({ abi: CORE_ABI, eventName: "PoolInitialized" })[0],
    )!;
    for (const [addresses, expected] of [
      [[NATIVE.extension], 1],
      [[WETH.extension], 0],
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
          p.filter.topics[0] === poolInitialized.topics[0],
      )!;
      await core.handler(dao, keyOf(poolInitialized), poolInitialized);
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
      [ZERO_SEED_LAUNCH_PINS[0].core, NATIVE.extension.toLowerCase(), 2, 3],
      [ZERO_SEED_LAUNCH_PINS[0].core, NATIVE.extension.toLowerCase(), 2, 3],
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

describe("LaunchCreated decoder guards", () => {
  it("accept every chain-emitted LaunchCreated against its instance's constructor quote", () => {
    for (const log of createdLogs) {
      const event = decodeCreated(log);
      const instance = instanceOf(log.address);
      expect(launchCreatedProblems(keyOf(log), event, instance.quote)).toEqual(
        [],
      );
      // native ETH is always token0, so the launch token is token1
      expect(BigInt(event.poolKey.token0) === 0n).toBe(
        instance.quoteKind === "native",
      );
    }
  });

  it("refuse logs whose fields disagree, and the handler stores nothing", async () => {
    const log = createdLogs[0];
    const event = decodeCreated(log);
    const quote = instanceOf(log.address).quote;
    const mutants: [string, typeof event, string][] = [
      [
        "liquidity",
        { ...event, liquidity: event.liquidity + 1n },
        "parameters.liquidity != liquidity",
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
        "pool tokens are not (token, constructor quote) in order",
      ],
      [
        "position",
        {
          ...event,
          positionId: toHex(BigInt(event.positionId) + 1n, { size: 32 }),
        },
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
      ["token", { ...event, token: quote }, "launch token is the quote"],
    ];
    for (const [name, mutated, problem] of mutants) {
      const key =
        name === "emitter"
          ? { ...keyOf(log), emitter: config.coreAddress }
          : keyOf(log);
      expect(launchCreatedProblems(key, mutated, quote)).toContain(problem);
    }
    const [created] = createZeroSeedLaunchProcessors({
      coreAddress: config.coreAddress,
      zeroSeedLaunchAddresses: [log.address],
    }).filter((p) => p.filter.topics[0] === LAUNCH_CREATED);
    const dao = {
      insertZeroSeedLaunchCreatedEvent: async () => {
        throw new Error("must not store");
      },
    } as unknown as DAO;
    await expectRejects(
      created.handler(dao, { ...keyOf(log), emitter: config.coreAddress }, log),
      /Refusing LaunchCreated/,
    );
  });

  it("refuses a launch against another instance's quote and 32-byte multibyte metadata", () => {
    const log = createdLogs.find(
      (l) => instanceOf(l.address).quoteKind === "native",
    )!;
    const event = decodeCreated(log);
    expect(launchCreatedProblems(keyOf(log), event, WETH.quote)).toContain(
      "pool tokens are not (token, constructor quote) in order",
    );
    for (const field of ["name", "symbol"] as const) {
      const withMetadata = (value: string) => ({
        ...event,
        parameters: { ...event.parameters, [field]: value },
      });
      expect(
        launchCreatedProblems(
          keyOf(log),
          withMetadata("é".repeat(15) + "a"),
          NATIVE.quote,
        ),
      ).toEqual([]);
      expect(
        launchCreatedProblems(
          keyOf(log),
          withMetadata("é".repeat(16)),
          NATIVE.quote,
        ),
      ).toContain("metadata exceeds 31 UTF-8 bytes");
    }
  });
});
