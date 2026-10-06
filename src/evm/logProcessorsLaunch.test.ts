import { describe, expect, it, mock } from "bun:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  numberToHex,
  type Abi,
  type AbiEvent,
} from "viem";
import { CORE_ABI } from "./abis_v3";
import {
  LAUNCH_ROUTER_ABI,
  LOCKED_LAUNCH_LIQUIDITY_ABI,
  SCHEDULED_LAUNCH_ABI,
} from "./abis_launch";
import { createLogProcessorsV3 } from "./logProcessorsV3";
import type { EvmLogProcessor } from "./logProcessorsShared";
import { stripNul } from "../_shared/dao";

const scheduledLaunchAddress = "0x5184f618B2d6cE625d9fDB9770E151a9B84EdB81";
const lockedLaunchLiquidityAddress =
  "0x4B4e88581110396a09E3Bc313199b96Ab1D8ADEA";
const launchRouterAddress = "0x9dae609a75Ac80BB84448a14823199faC514aeDb";

const config = {
  mevCaptureAddress: "0x0000000000000000000000000000000000000001",
  boostedFeesConcentratedAddress: "0x0000000000000000000000000000000000000002",
  boostedFeesStableswapAddress: "0x0000000000000000000000000000000000000003",
  coreAddress: "0x0000000000000000000000000000000000000004",
  oracleAddress: "0x0000000000000000000000000000000000000005",
  incentivesAddress: "0x0000000000000000000000000000000000000006",
  tokenWrapperFactoryAddress: "0x0000000000000000000000000000000000000007",
  auctionsAddress: "0x0000000000000000000000000000000000000008",
  twammAddresses: [] as `0x${string}`[],
  ordersAddresses: [] as `0x${string}`[],
  positionsContracts: [],
} as const;

const launchConfig = {
  ...config,
  scheduledLaunchAddress,
  lockedLaunchLiquidityAddress,
  launchRouterAddress,
} as const;

const poolId = `0x${"41".padStart(64, "0")}` as const;
const terminalPoolId = `0x${"42".padStart(64, "0")}` as const;
const router = "0x9dae609a75Ac80BB84448a14823199faC514aeDb";
const creator = "0x00000000000000000000000000000000000000cc";
const token = "0x00000000000000000000000000000000000000aa";
const quoteToken = "0x00000000000000000000000000000000000000bb";
const recipient = "0x00000000000000000000000000000000000000dd";

const key = {
  blockNumber: 1,
  transactionIndex: 2,
  eventIndex: 3,
  emitter: scheduledLaunchAddress,
  transactionHash: `0x${"50".padStart(64, "0")}`,
} as const;

// A log as eth_getLogs returns it: indexed inputs as topics, the rest as data.
function encodeLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
) {
  const event = abi.find(
    (item): item is AbiEvent =>
      item.type === "event" && item.name === eventName,
  )!;
  const unindexed = event.inputs.filter((input) => !input.indexed);
  return {
    topics: encodeEventTopics({
      abi: [event],
      eventName,
      args: Object.fromEntries(
        event.inputs
          .filter((input) => input.indexed)
          .map((input) => [input.name!, args[input.name!]]),
      ),
    } as never) as `0x${string}`[],
    data: encodeAbiParameters(
      unindexed,
      unindexed.map((input) => args[input.name!]),
    ),
  };
}

function processorFor(
  processors: EvmLogProcessor[],
  address: string,
  topics: `0x${string}`[],
) {
  const matching = processors.filter(
    (candidate) =>
      candidate.address === address && candidate.filter.topics[0] === topics[0],
  );
  expect(matching).toHaveLength(1);
  return matching[0]!;
}

async function process(
  address: `0x${string}`,
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  daoMethod: string,
) {
  const log = encodeLog(abi, eventName, args);
  const processor = processorFor(
    createLogProcessorsV3(launchConfig),
    address,
    log.topics,
  );
  const method = mock(async () => {});
  await processor.handler(
    { [daoMethod]: method } as never,
    { ...key, emitter: address },
    log,
  );
  expect(method).toHaveBeenCalledTimes(1);
  return (method.mock.calls[0] as unknown[])[1];
}

describe("launch log processors", () => {
  it("watches nothing when no launch address is configured", () => {
    const addresses = [
      scheduledLaunchAddress,
      lockedLaunchLiquidityAddress,
      launchRouterAddress,
    ];
    expect(
      createLogProcessorsV3(config).filter((p) =>
        addresses.includes(p.address),
      ),
    ).toHaveLength(0);
  });

  it("watches 4 + 3 + 1 events when all three are configured", () => {
    const processors = createLogProcessorsV3(launchConfig);
    const count = (address: string) =>
      processors.filter((p) => p.address === address).length;
    expect(count(scheduledLaunchAddress)).toBe(4);
    expect(count(lockedLaunchLiquidityAddress)).toBe(3);
    expect(count(launchRouterAddress)).toBe(1);
  });

  it("each launch address is optional on its own", () => {
    const processors = createLogProcessorsV3({
      ...config,
      launchRouterAddress,
    });
    expect(
      processors.filter((p) => p.address === launchRouterAddress),
    ).toHaveLength(1);
    expect(
      processors.filter((p) => p.address === scheduledLaunchAddress),
    ).toHaveLength(0);
  });

  it("registers a pool whose extension is ScheduledLaunch at PoolInitialized", async () => {
    const poolInitialized = (extension: `0x${string}`) =>
      encodeLog(CORE_ABI as Abi, "PoolInitialized", {
        poolId,
        poolKey: {
          token0: token,
          token1: quoteToken,
          // concentrated, fee 0, tick spacing 100
          config: numberToHex(
            (BigInt(extension) << 96n) | 0x80000000n | 100n,
            { size: 32 },
          ),
        },
        tick: -5,
        sqrtRatio: 1n << 95n,
      });

    for (const [extension, expected] of [
      [scheduledLaunchAddress, 1],
      ["0x0000000000000000000000000000000000000099", 0],
    ] as const) {
      const log = poolInitialized(extension);
      const processor = processorFor(
        createLogProcessorsV3(launchConfig),
        config.coreAddress,
        log.topics,
      );
      const insertPoolInitializedEvent = mock(async () => {});
      const insertMEVCapturePoolKey = mock(async () => {});
      const insertScheduledLaunchPoolKey = mock(async () => {});
      await processor.handler(
        {
          insertPoolInitializedEvent,
          insertMEVCapturePoolKey,
          insertScheduledLaunchPoolKey,
        } as never,
        { ...key, emitter: config.coreAddress },
        log,
      );
      expect(insertPoolInitializedEvent).toHaveBeenCalledTimes(1);
      expect(insertMEVCapturePoolKey).toHaveBeenCalledTimes(0);
      expect(insertScheduledLaunchPoolKey).toHaveBeenCalledTimes(expected);
      if (expected) {
        expect(insertScheduledLaunchPoolKey).toHaveBeenCalledWith(
          config.coreAddress,
          poolId,
        );
      }
    }
  });

  it("LaunchCreated", async () => {
    const launch = {
      owner: router,
      quoteToken,
      name: "Launch",
      symbol: "LNCH",
      decimals: 18,
      totalSupply: 10n ** 27n,
      startTime: 1_800_000_000n,
      endTime: 1_800_086_400n,
      targetTick: -276_324,
      upperTick: -207_243,
      tickSpacing: 100,
      initialFee: 1n << 62n,
      finalFee: 1n << 55n,
      migrationTickLower: -300_000,
      migrationTickUpper: -200_000,
    };
    expect(
      await process(
        scheduledLaunchAddress,
        SCHEDULED_LAUNCH_ABI,
        "LaunchCreated",
        { poolId, token, owner: router, config: launch },
        "insertScheduledLaunchCreatedEvent",
      ),
    ).toEqual({
      coreAddress: config.coreAddress,
      poolId,
      // viem checksums decoded addresses
      token: getAddress(token),
      owner: router,
      quoteToken: getAddress(quoteToken),
      name: "Launch",
      symbol: "LNCH",
      decimals: 18,
      totalSupply: 10n ** 27n,
      startTime: 1_800_000_000n,
      endTime: 1_800_086_400n,
      targetTick: -276_324,
      upperTick: -207_243,
      tickSpacing: 100,
      initialFee: 1n << 62n,
      finalFee: 1n << 55n,
      migrationTickLower: -300_000,
      migrationTickUpper: -200_000,
    });
  });

  it("LaunchAdvanced", async () => {
    expect(
      await process(
        scheduledLaunchAddress,
        SCHEDULED_LAUNCH_ABI,
        "LaunchAdvanced",
        { poolId, deployed: 7n, reserve0: 8n, reserve1: 9n, complete: true },
        "insertScheduledLaunchAdvancedEvent",
      ),
    ).toEqual({
      coreAddress: config.coreAddress,
      poolId,
      deployed: 7n,
      reserve0: 8n,
      reserve1: 9n,
      complete: true,
    });
  });

  it("LaunchSwapped", async () => {
    expect(
      await process(
        scheduledLaunchAddress,
        SCHEDULED_LAUNCH_ABI,
        "LaunchSwapped",
        {
          poolId,
          locker: router,
          delta0: -(2n ** 100n),
          delta1: 12345n,
          feeAmount: 17n,
          feeIsToken1: false,
        },
        "insertScheduledLaunchSwappedEvent",
      ),
    ).toEqual({
      coreAddress: config.coreAddress,
      poolId,
      locker: router,
      delta0: -(2n ** 100n),
      delta1: 12345n,
      feeAmount: 17n,
      feeIsToken1: false,
    });
  });

  it("CreatorFeesClaimed", async () => {
    expect(
      await process(
        scheduledLaunchAddress,
        SCHEDULED_LAUNCH_ABI,
        "CreatorFeesClaimed",
        { poolId, recipient, amount0: 1n, amount1: 2n },
        "insertScheduledLaunchCreatorFeesClaimedEvent",
      ),
    ).toEqual({
      coreAddress: config.coreAddress,
      poolId,
      account: getAddress(recipient),
      amount0: 1n,
      amount1: 2n,
    });
  });

  it("PrincipalReceived", async () => {
    expect(
      await process(
        lockedLaunchLiquidityAddress,
        LOCKED_LAUNCH_LIQUIDITY_ABI,
        "PrincipalReceived",
        { launchId: poolId, from: router, amount0: 3n, amount1: 4n },
        "insertLaunchPrincipalReceivedEvent",
      ),
    ).toEqual({
      coreAddress: config.coreAddress,
      poolId,
      account: router,
      amount0: 3n,
      amount1: 4n,
    });
  });

  it("LiquidityLocked", async () => {
    expect(
      await process(
        lockedLaunchLiquidityAddress,
        LOCKED_LAUNCH_LIQUIDITY_ABI,
        "LiquidityLocked",
        { launchId: poolId, terminalPoolId, liquidity: 2n ** 120n },
        "insertLaunchLiquidityLockedEvent",
      ),
    ).toEqual({
      coreAddress: config.coreAddress,
      poolId,
      terminalPoolId,
      liquidity: 2n ** 120n,
    });
  });

  it("FeesClaimed", async () => {
    expect(
      await process(
        lockedLaunchLiquidityAddress,
        LOCKED_LAUNCH_LIQUIDITY_ABI,
        "FeesClaimed",
        { launchId: poolId, recipient, amount0: 5n, amount1: 6n },
        "insertLaunchLockedFeesClaimedEvent",
      ),
    ).toEqual({
      coreAddress: config.coreAddress,
      poolId,
      account: getAddress(recipient),
      amount0: 5n,
      amount1: 6n,
    });
  });

  it("LaunchCreatedBy", async () => {
    expect(
      await process(
        launchRouterAddress,
        LAUNCH_ROUTER_ABI,
        "LaunchCreatedBy",
        { launchId: poolId, creator },
        "insertLaunchCreatedByEvent",
      ),
    ).toEqual({
      coreAddress: config.coreAddress,
      poolId,
      creator: getAddress(creator),
    });
  });

  it("strips NUL from launch names before they reach a text column", () => {
    expect(stripNul("a\u0000b\u0000")).toBe("ab");
  });
});
