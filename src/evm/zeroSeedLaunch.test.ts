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

// The protocol's interface manifest of evm-contracts 43d6628, vendored
// verbatim: generated from the build artifacts, not from this code.
// The protocol's exact installation vectors of evm-contracts 43d6628, vendored
// verbatim (sha256 b06f6576...330d): an independent integer oracle, not this
// code. previousLiquidity is what the shared helper installed before.
const installationVectors = (
  readJson("zero-seed-launch-installation.json") as {
    vectors: {
      label: string;
      order: "t0" | "t1";
      askTick: number;
      upperTick: number;
      tickSpacing: number;
      supply: string;
      liquidity?: string;
      installedSupply?: string;
      sink?: string;
      previousLiquidity: string;
      error?: string;
    }[];
  }
).vectors;

const manifest = readJson("zero-seed-interface-43d6628.json") as {
  manifest_sha256: string;
  removed_from_abi: Record<string, string>;
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

// The interface accepted for implementation: evm-contracts 43d6628.
const FROZEN = {
  abiSha256: "efae9388aa6b1342479204ddf436fd2a310df16bf06c80c990b2d22c90d1e41e",
  peripheryAbiSha256:
    "df24d9f07d45323da7e46c0f6e64ce24f8f522442d60cb07880ddf742ebe7305",
  evmContractsHead: "43d6628841b3ce91dafa048b7ceef64bed55fc8e",
  evmContractsTree: "9ab869d1a453b8df48d47c2e0e2fb2d4ca8f67bf",
  coreRuntimeKeccak:
    "0xc5f90c9d0dbc5037f8f9e248f4bb292e7c1824f584eb6550cb4cad525b38c71a",
  launchCreationKeccak:
    "0x10f4088a9ae5dff5f2caa7d005c4da80e8ece5c515b6f3e4e5ab452606f2b2ff",
  peripheryCreationKeccak:
    "0x7ec2d7eb35806d3ec7edab5809a6b5441977afc32ad3b5276cd9437d0d276f88",
  launchRuntimeTemplate:
    "0x19d7461a57e0058bd09c848684152a234b4b3909404c1c85dbf6e69b9d59c925",
  peripheryRuntimeTemplate:
    "0x76db610aa6d183253d966ff21d2c59f750028b9ad83c0e4cc0d362324740e2e7",
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
      const errors = Object.fromEntries(
        items
          .filter((i) => i.type === "error")
          .map((e) => {
            const signature = toFunctionSignature(e as unknown as AbiFunction)
              .replaceAll(" ", "")
              .replace(/^error/, "");
            return [signature, toFunctionSelector(signature)];
          }),
      );
      expect(functions).toEqual(manifest.abi[name].functions);
      expect(events).toEqual(manifest.abi[name].events);
      expect(errors).toEqual(manifest.abi[name].errors ?? {});
    }
    // FeeTooHigh() 0xcd4e6167 left the interface: every uint64 rate is valid.
    expect(manifest.removed_from_abi).toEqual({ "FeeTooHigh()": "0xcd4e6167" });
    expect(
      abiItems(ZERO_SEED_LAUNCH_ABI).some((i) => i.name === "FeeTooHigh"),
    ).toBe(false);
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
    expect(createdLogs.length).toBe(8);
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
    const exactOnly: string[] = [];
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
      // the protocol's exact installation vector for these inputs
      const exact = installationVectors.find(
        (v) =>
          v.order === (launch.tokenIsToken1 ? "t1" : "t0") &&
          v.askTick === Number(event.parameters.askTick) &&
          v.upperTick === Number(event.parameters.upperTick) &&
          v.tickSpacing === Number(event.parameters.tickSpacing) &&
          v.supply === launch.requestedSupply,
      )!;
      expect(exact.error).toBeUndefined();
      const recorded: (string | undefined)[] = [
        launch.liquidity,
        launch.installedSupply,
        launch.sinkSupply,
      ];
      expect(recorded).toEqual([
        exact.liquidity,
        exact.installedSupply,
        exact.sink,
      ]);
      if (exact.previousLiquidity !== exact.liquidity) {
        exactOnly.push(launch.label);
        continue;
      }
      // the protocol's 18/18 manifest examples for the default geometry
      expect(requested).toBe(10n ** 27n);
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
    // l7 and l8 are token0 launches where the exact maximum installs more
    // than the shared helper; l8 installs its whole supply and mints no sink.
    expect(exactOnly.sort()).toEqual(["l7", "l8"]);
    expect(fixture.launches.l8.sinkSupply).toBe("0");
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

  it("only the two local fixture instances are pinned, one per fee model, with no quote; no live pin exists", () => {
    expect(ZERO_SEED_LAUNCH_PINS).toHaveLength(2);
    expect(ZERO_SEED_LAUNCH_PINS.map((p) => [p.feeModel, p.local])).toEqual([
      ["fixed_base_duration_v1", true],
      ["tick_rate_v2", true],
    ]);
    const v2 = readJson("local-chain-v2.json") as typeof fixture & {
      feeModel: string;
    };
    expect(v2.feeModel).toBe("tick_rate_v2");
    expect(v2.provenance.evmContractsHead).toBe(
      "3d6378f585591dc7eabeea6976932c30524bb8ea",
    );
    const [v2Instance] = v2.instances;
    const v2Pin = ZERO_SEED_LAUNCH_PINS[1];
    expect([
      v2Pin.address,
      v2Pin.runtimeCodehash,
      v2Pin.periphery,
      v2Pin.peripheryRuntimeCodehash,
      v2Pin.deploymentBlock,
      v2Pin.abiSha256,
      v2Pin.peripheryAbiSha256,
    ]).toEqual([
      v2Instance.extension.toLowerCase() as `0x${string}`,
      v2Instance.extensionRuntimeKeccak,
      v2Instance.periphery.toLowerCase() as `0x${string}`,
      v2Instance.peripheryRuntimeKeccak,
      v2Instance.deploymentBlock,
      v2.provenance.launchAbiSha256 as string,
      v2.provenance.peripheryAbiSha256 as string,
    ]);
    // The frozen extension runtime of the tick-rate revision.
    expect(v2Pin.runtimeCodehash).toBe(
      "0xe08ad382497fc9825956c2b4e9ccf463014c4ed65baf50c0a59db8d7b7aedfc3",
    );
    // A pin's model and ABI must agree: the v2 pin with the v1 model is refused.
    expect(() =>
      resolveZeroSeedLaunchPin({
        ...base,
        address: v2Pin.address,
        runtimeCodehash: v2Pin.runtimeCodehash,
        pins: [{ ...v2Pin, feeModel: "fixed_base_duration_v1" }],
      }),
    ).toThrow(/another ABI/);
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
    expect(poolInitialized).toHaveLength(8);
    for (const [addresses, expected] of [
      [[INSTANCE.extension], 8],
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

  it("decodes the maximum Q0.64 rate 2^64 - 1 exactly from normally created launches and their swaps", async () => {
    const MAX = 2n ** 64n - 1n;
    const stored: ZeroSeedLaunchCreatedInsert[] = [];
    const swapped: Record<string, unknown>[] = [];
    const dao = {
      insertZeroSeedLaunchCreatedEvent: async (
        _key: unknown,
        row: ZeroSeedLaunchCreatedInsert,
      ) => void stored.push(row),
      insertZeroSeedLaunchSwappedEvent: async (
        _key: unknown,
        row: Record<string, unknown>,
      ) => void swapped.push(row),
    } as unknown as DAO;
    const processors = createZeroSeedLaunchProcessors({
      coreAddress: config.coreAddress,
      zeroSeedLaunchAddresses: [INSTANCE.extension],
    });
    const swappedProcessor = processors.find(
      (p) => p.filter.topics[0] === FROZEN.topics.LaunchSwapped,
    )!;
    const maxPools = new Set<string>([
      fixture.launches.l5.poolId,
      fixture.launches.l6.poolId,
    ]);
    for (const log of createdLogs.filter((l) =>
      maxPools.has(decodeCreated(l).poolId),
    )) {
      expect(launchCreatedProblems(keyOf(log), decodeCreated(log))).toEqual([]);
      await createdProcessor.handler(dao, keyOf(log), log);
    }
    expect(
      stored.map((r) => [
        String(r.initialFee),
        String(r.finalFee),
        r.feeModel,
        r.feeModel === "fixed_base_duration_v1" ? r.feeDuration : undefined,
      ]),
    ).toEqual([
      [String(MAX), "55340232221128654", "fixed_base_duration_v1", 3600],
      [String(MAX), String(MAX), "fixed_base_duration_v1", 1],
    ]);
    const maxSwaps = fixture.branches.canonical.logs.filter(
      (l) =>
        l.topics[0] === FROZEN.topics.LaunchSwapped &&
        maxPools.has(l.topics[1] as string),
    );
    for (const log of maxSwaps)
      await swappedProcessor.handler(dao, keyOf(log), log);
    const atMax = swapped.filter((r) => r.feeRate === MAX);
    // exact input (fee on the launch token) and exact output (fee on the quote)
    // in both quote kinds at 2^64 - 1, then l5 decayed to its 0.3% final rate
    expect(atMax).toHaveLength(4);
    expect(
      swapped.filter((r) => r.feeRate === 55340232221128654n),
    ).toHaveLength(2);
    for (const r of atMax) {
      const [d0, d1] = [r.delta0 as bigint, r.delta1 as bigint];
      const fee = r.feeAmount as bigint;
      const feeIsToken1 = r.feeIsToken1 as boolean;
      const calculated = feeIsToken1 ? d1 : d0;
      if (calculated < 0n) {
        // exact input: net output floor(gross / 2^64), the rest is the fee
        const gross = -calculated + fee;
        expect(-calculated).toBe(gross / 2n ** 64n);
      } else {
        // exact output: paid input calculated * 2^64
        expect(calculated % 2n ** 64n).toBe(0n);
        expect(fee).toBe((calculated / 2n ** 64n) * MAX);
      }
    }
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
