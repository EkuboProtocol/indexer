import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeEventLog,
  encodeEventTopics,
  toEventSignature,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
} from "viem";
import {
  LAUNCH_TOKEN_ABI,
  ZERO_SEED_LAUNCH_ABI,
  ZERO_SEED_LAUNCH_PERIPHERY_ABI,
} from "./abis_zero_seed_launch";
import {
  resolveZeroSeedLaunchPin,
  ZERO_SEED_LAUNCH_PINS,
  type ZeroSeedLaunchPin,
} from "./zeroSeedLaunchConfig";
import {
  alignLaunchRange,
  launchCreatedLogoBytes,
  launchCreatedProblems,
  launchCreatedRow,
  storableText,
  unpackLaunchString,
  type LaunchCreated,
} from "./zeroSeedLaunchProcessors";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path));
const json = <T>(path: string) => JSON.parse(read(path).toString("utf8")) as T;
const FREEZE = "tests/fixtures/zero-seed-launch/freeze-853b608";
const ABI_DIR = "src/evm/abis/zero-seed-launch";
type Hex = `0x${string}`;
type RawLog = { emitter?: Hex; topics: Hex[]; data: Hex };

const vectors = json<{
  abi: Record<
    string,
    { events: Record<string, Hex>; selectors: Record<string, Hex> }
  >;
  metadata: { examples: Record<string, Hex> };
}>(`${FREEZE}/zero-seed-launch.json`);
const events = json<{
  LaunchCreated: (RawLog & { logo: string })[];
  receipt: (RawLog & { emitter: Hex })[];
}>(`${FREEZE}/zero-seed-launch-events.json`);

describe("frozen 853b608 interface", () => {
  test("every copied file has the hash recorded in PROVENANCE.md", () => {
    const provenance = read(`${FREEZE}/PROVENANCE.md`).toString("utf8");
    const rows = [
      ...provenance.matchAll(
        /^\| `([^`]+)` \| `[^`]+` \| `([0-9a-f]{64})` \|$/gm,
      ),
    ];
    expect(rows.length).toBe(6);
    for (const [, file, sha] of rows) {
      const path = file.startsWith("src/") ? file : `${FREEZE}/${file}`;
      expect(createHash("sha256").update(read(path)).digest("hex")).toBe(sha);
    }
  });

  test("the typed ABIs equal the compiled JSON entry for entry", () => {
    for (const [name, abi] of [
      ["ZeroSeedLaunch", ZERO_SEED_LAUNCH_ABI],
      ["ZeroSeedLaunchPeriphery", ZERO_SEED_LAUNCH_PERIPHERY_ABI],
      ["LaunchToken", LAUNCH_TOKEN_ABI],
    ] as const)
      expect(abi as unknown).toEqual(json(`${ABI_DIR}/${name}.abi.json`));
  });

  test("event topics and selectors of the ABIs equal the frozen vectors", () => {
    for (const [name, abi] of [
      ["ZeroSeedLaunch", ZERO_SEED_LAUNCH_ABI],
      ["ZeroSeedLaunchPeriphery", ZERO_SEED_LAUNCH_PERIPHERY_ABI],
      ["LaunchToken", LAUNCH_TOKEN_ABI],
    ] as const) {
      const fromAbi = Object.fromEntries(
        (abi as Abi)
          .filter((i): i is AbiEvent => i.type === "event")
          .map((e) => [
            toEventSignature(e),
            encodeEventTopics({ abi: [e] } as never)[0],
          ]),
      );
      expect(fromAbi).toEqual(vectors.abi[name].events);
      for (const [signature, selector] of Object.entries(
        vectors.abi[name].selectors,
      )) {
        const fn = (abi as Abi).find(
          (i): i is AbiFunction =>
            i.type === "function" &&
            signature.startsWith(`${i.name}(`) &&
            toFunctionSelector(i) === selector,
        );
        expect(fn, signature).toBeDefined();
      }
    }
    // the seven events indexed or classified here
    expect(
      Object.values(vectors.abi).flatMap((a) => Object.keys(a.events)).length,
    ).toBe(7);
  });

  test("every raw receipt log decodes strictly with its emitter's ABI", () => {
    // the local Forge extension of the receipts
    const extension = "0x5100000000000000000000000000000000000000";
    const abiFor = (log: RawLog & { emitter: Hex }): Abi =>
      log.emitter.toLowerCase() === extension
        ? ZERO_SEED_LAUNCH_ABI
        : log.topics[0] ===
              vectors.abi.LaunchToken.events[
                "Transfer(address,address,uint256)"
              ] ||
            log.topics[0] ===
              vectors.abi.LaunchToken.events[
                "Approval(address,address,uint256)"
              ]
          ? LAUNCH_TOKEN_ABI
          : ZERO_SEED_LAUNCH_PERIPHERY_ABI;
    const names: string[] = events.receipt.map(
      (log): string =>
        decodeEventLog({
          abi: abiFor(log),
          topics: log.topics as [Hex],
          data: log.data,
          strict: true,
        }).eventName as unknown as string,
    );
    expect(names).toEqual([
      "Transfer",
      "Transfer",
      "LaunchCreated",
      "LaunchOwnerChanged",
      "Approval",
      "LaunchSwapped",
      "Transfer",
      "CreatorFeesClaimed",
      "Transfer",
      "LaunchFeesClaimed",
      "LaunchOwnerChanged",
    ]);
    expect(new Set(names).size).toBe(7);
  });
});

describe("LaunchCreated of the frozen receipts", () => {
  const decode = (log: RawLog) =>
    decodeEventLog({
      abi: ZERO_SEED_LAUNCH_ABI,
      eventName: "LaunchCreated",
      topics: log.topics as [Hex],
      data: log.data,
      strict: true,
    }).args as LaunchCreated;
  const key = { emitter: "0x5100000000000000000000000000000000000000" as Hex };

  for (const created of events.LaunchCreated)
    test(`logo ${JSON.stringify(created.logo)}: consistent, stored raw, derived geometry`, () => {
      const event = decode(created);
      expect(launchCreatedProblems(key, event)).toEqual([]);
      const bytes = launchCreatedLogoBytes(created.data);
      expect(Buffer.from(bytes).toString("utf8")).toBe(created.logo);
      const row = launchCreatedRow(
        event,
        bytes,
        "0x00000000000014aA86C5d3c41765bb24e11bd701",
      );
      expect(row).toMatchObject({
        name: "Zero Seed",
        symbol: "ZERO",
        nameWord: vectors.metadata.examples["Zero Seed"],
        symbolWord: vectors.metadata.examples.ZERO,
        logoUrl: created.logo,
        askTick: -13815500,
        upperTick: -9210300,
        tickSpacing: 17990,
        alignedAskTick: -13798330,
        alignedUpperTick: -9210880,
        requestedSupply: 10n ** 27n,
        decayRateX32: 68913100933n,
        quoteToken: "0x0000000000000000000000000000000000000000",
      });
    });

  test("a pool key with another spacing or extension is refused", () => {
    const event = decode(events.LaunchCreated[0]);
    expect(
      launchCreatedProblems(
        { emitter: "0x0000000000000000000000000000000000000001" },
        event,
      ),
    ).toContain("pool extension is not the emitter");
    const config = BigInt(event.poolKey.config) + 1n;
    expect(
      launchCreatedProblems(key, {
        ...event,
        poolKey: {
          ...event.poolKey,
          config: `0x${config.toString(16).padStart(64, "0")}`,
        },
      }),
    ).toContain("pool tick spacing is not the derived spacing");
  });
});

describe("derived spacing and packed strings", () => {
  test("alignLaunchRange reproduces every installed row of the 64 installation vectors", () => {
    const { vectors: rows } = json<{
      vectors: {
        askTick: number;
        upperTick: number;
        tickSpacing: number;
        alignedAskTick: number;
        alignedUpperTick: number;
      }[];
    }>(`${FREEZE}/zero-seed-launch-installation.json`);
    expect(rows.length).toBe(64);
    // refusal rows (InvalidSupply, InvalidTicks, ...) carry no geometry
    const installed = rows.filter((r) => r.tickSpacing !== undefined);
    expect(installed.length).toBe(56);
    for (const r of installed)
      expect(alignLaunchRange(r.askTick, r.upperTick)).toEqual({
        tickSpacing: r.tickSpacing,
        alignedAskTick: r.alignedAskTick,
        alignedUpperTick: r.alignedUpperTick,
      });
    // signed rounding, not truncation toward zero
    expect(alignLaunchRange(-5000001, 4999999)).toEqual({
      tickSpacing: 39063,
      alignedAskTick: -4961001,
      alignedUpperTick: 4961001,
    });
  });

  test("unpackLaunchString accepts only canonical packOne words", () => {
    expect(
      storableText(unpackLaunchString(vectors.metadata.examples.ZERO)!),
    ).toBe("ZERO");
    const word = (s: string): Hex => `0x${s.padEnd(64, "0")}`;
    expect(unpackLaunchString(word(""))).toBeUndefined(); // zero / length 0
    expect(unpackLaunchString(word("20" + "41".repeat(31)))).toBeUndefined(); // length 32
    expect(
      unpackLaunchString(word("0141" + "00".repeat(29) + "01")),
    ).toBeUndefined(); // dirty tail
    expect(unpackLaunchString(word("1f" + "41".repeat(31)))?.length).toBe(31);
    // arbitrary bytes round-trip; text only when UTF-8 without NUL
    expect(storableText(unpackLaunchString(word("025aff"))!)).toBeUndefined();
    expect(storableText(unpackLaunchString(word("025a00"))!)).toBeUndefined();
  });
});

describe("launch support configuration", () => {
  const pin: ZeroSeedLaunchPin = {
    chainId: 31337n,
    address: "0x51c4Ad945fBeF67859d92F1690cBf86df12e3B7c",
    runtimeCodehash:
      "0xa66e365089d80b017edeb98237831260bf9e1b7d5f3965d42be5672de6b0d70e",
    periphery: "0x6963dE1652c96Fb0EaEAF5167dE3c89E187284f2",
    core: "0x00000000000014aA86C5d3c41765bb24e11bd701",
    deploymentBlock: 2,
    local: true,
    source: "test",
  };
  const env = {
    chainId: 31337n,
    address: pin.address,
    runtimeCodehash: pin.runtimeCodehash,
    coreAddress: pin.core,
    production: false,
  };

  test("no deployment is pinned: support is off by default on every chain", () => {
    expect(ZERO_SEED_LAUNCH_PINS).toEqual([]);
    const warnings: string[] = [];
    expect(
      resolveZeroSeedLaunchPin({ ...env, warn: (m) => warnings.push(m) }),
    ).toBeUndefined();
    expect(warnings).toEqual([
      "No ZeroSeedLaunch pin for chain 31337; launch indexing is off",
    ]);
    expect(
      resolveZeroSeedLaunchPin({ ...env, address: undefined }),
    ).toBeUndefined();
  });

  test("an injected local pin resolves, but never in production or for another runtime or Core", () => {
    expect(resolveZeroSeedLaunchPin({ ...env, pins: [pin] })).toBe(pin);
    expect(() =>
      resolveZeroSeedLaunchPin({ ...env, production: true, pins: [pin] }),
    ).toThrow(/local fixture/);
    expect(() =>
      resolveZeroSeedLaunchPin({
        ...env,
        runtimeCodehash: `0x${"11".repeat(32)}`,
        pins: [pin],
      }),
    ).toThrow(/does not match the pin/);
    expect(() =>
      resolveZeroSeedLaunchPin({
        ...env,
        coreAddress: "0x0000000000000000000000000000000000000001",
        pins: [pin],
      }),
    ).toThrow(/Core does not match/);
    expect(() =>
      resolveZeroSeedLaunchPin({
        ...env,
        address: "0x0000000000000000000000000000000000000002",
        pins: [pin],
      }),
    ).toThrow(/not a pinned launch/);
  });
});
