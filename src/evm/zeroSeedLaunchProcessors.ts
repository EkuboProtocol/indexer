import type { DAO } from "../_shared/dao";
import type { EventKey } from "../_shared/eventKey";
import {
  ZERO_SEED_LAUNCH_ABI,
  ZERO_SEED_LAUNCH_PERIPHERY_ABI,
} from "./abis_zero_seed_launch";
import {
  ZERO_SEED_LAUNCH_PERIPHERY_V2_ABI,
  ZERO_SEED_LAUNCH_V2_ABI,
} from "./abis_zero_seed_launch_v2";
import {
  createProcessorsFromHandlers,
  type ContractEvent,
  type ContractHandlers,
  type EvmLogProcessor,
} from "./logProcessorsShared";
import { parsePositionId, parseV2PoolKeyConfig, toPoolId } from "./poolKey";
import {
  zeroSeedLaunchPinForAddress,
  type ZeroSeedLaunchPin,
} from "./zeroSeedLaunchConfig";

type LaunchCreatedV1 = ContractEvent<
  typeof ZERO_SEED_LAUNCH_ABI,
  "LaunchCreated"
>;
type LaunchCreatedV2 = ContractEvent<
  typeof ZERO_SEED_LAUNCH_V2_ABI,
  "LaunchCreated"
>;
type LaunchCreated = LaunchCreatedV1 | LaunchCreatedV2;

const same = (a: string, b: string) => BigInt(a) === BigInt(b);
const utf8Length = (value: string) => new TextEncoder().encode(value).length;

const INT128_MAX = (1n << 127n) - 1n;

/**
 * Reasons a LaunchCreated log disagrees with itself or its emitter. The quote
 * is the launch's own parameters.quoteToken (address 0 for native ETH, which
 * is then always token0), and it must be the other token of the pool key. The
 * stored row derives the position's pool ticks from the economic ticks and the
 * token order, so the log's own pool key and position id must say the same
 * thing. The installed supply is not in the log; the DAO takes it from Core's
 * PositionUpdated of the same transaction.
 */
export function launchCreatedProblems(
  key: Pick<EventKey, "emitter">,
  event: LaunchCreated,
): string[] {
  const { poolKey, parameters, positionId } = event;
  const { quoteToken } = parameters;
  const config = parseV2PoolKeyConfig(poolKey.config);
  const tokenIs0 = BigInt(event.token) < BigInt(quoteToken);
  const [token0, token1] = tokenIs0
    ? [event.token, quoteToken]
    : [quoteToken, event.token];
  const position = parsePositionId(positionId);
  const [lower, upper] = tokenIs0
    ? [parameters.askTick, parameters.upperTick]
    : [-parameters.upperTick, -parameters.askTick];

  return [
    [!same(event.token, quoteToken), "launch token is the quote"],
    [
      utf8Length(parameters.name) <= 31 && utf8Length(parameters.symbol) <= 31,
      "metadata exceeds 31 UTF-8 bytes",
    ],
    [event.liquidity > 0n, "liquidity is 0"],
    [
      parameters.supply > 0n && parameters.supply <= INT128_MAX,
      "requested supply is outside 1..int128.max",
    ],
    [same(config.extension, key.emitter), "pool extension is not the emitter"],
    [
      toPoolId(poolKey) === event.poolId.toLowerCase(),
      "poolId != id of poolKey",
    ],
    [
      same(poolKey.token0, token0) && same(poolKey.token1, token1),
      "pool tokens are not (token, quoteToken) in order",
    ],
    [config.fee === 0n, "Core fee is not 0"],
    [
      "tickSpacing" in config && config.tickSpacing === parameters.tickSpacing,
      "tick spacing differs",
    ],
    [
      position.salt === 0n &&
        position.lower === lower &&
        position.upper === upper,
      "position is not (salt 0, tick_lower, tick_upper)",
    ],
  ]
    .filter(([ok]) => !ok)
    .map(([, problem]) => problem as string);
}

/**
 * The events of each pinned instance: the extension's three and its
 * periphery's two, decoded with the frozen ABIs.
 */
export function createZeroSeedLaunchProcessors({
  coreAddress,
  zeroSeedLaunchAddresses,
}: {
  coreAddress: `0x${string}`;
  zeroSeedLaunchAddresses?: readonly `0x${string}`[];
}): EvmLogProcessor[] {
  return (zeroSeedLaunchAddresses ?? []).flatMap((address) => {
    const pin = zeroSeedLaunchPinForAddress(address);
    if (!pin || !same(pin.core, coreAddress))
      throw new Error(
        "ZeroSeedLaunch event processor lacks reviewed instance/Core provenance",
      );
    // The pin's fee model selects the only ABI its logs are decoded with: a
    // LaunchCreated of the other revision has another topic and is ignored.
    if (pin.feeModel === "tick_rate_v2")
      return createProcessorsFromHandlers({
        ZeroSeedLaunch: {
          address: pin.address,
          ...zeroSeedLaunchV2Handlers(coreAddress),
        },
        ZeroSeedLaunchPeriphery: {
          address: pin.periphery,
          ...zeroSeedLaunchPeripheryV2Handlers(coreAddress, pin),
        },
      });
    if (pin.feeModel !== "fixed_base_duration_v1")
      throw new Error(
        `Unknown ZeroSeedLaunch fee model ${String(pin.feeModel)}`,
      );
    return createProcessorsFromHandlers({
      ZeroSeedLaunch: {
        address: pin.address,
        ...zeroSeedLaunchHandlers(coreAddress),
      },
      ZeroSeedLaunchPeriphery: {
        address: pin.periphery,
        ...zeroSeedLaunchPeripheryHandlers(coreAddress, pin),
      },
    });
  });
}

/** Pure event decoding, also used by isolated replay tests.
 * Service entrypoints MUST use createZeroSeedLaunchProcessors above.
 */
export function zeroSeedLaunchHandlers(
  coreAddress: `0x${string}`,
): Omit<ContractHandlers<typeof ZERO_SEED_LAUNCH_ABI>, "address"> {
  return {
    abi: ZERO_SEED_LAUNCH_ABI,
    handlers: {
      async LaunchCreated(dao, key, event) {
        await insertLaunchCreated(dao, key, event, coreAddress, {
          feeModel: "fixed_base_duration_v1",
          feeDuration: event.parameters.feeDuration,
        });
      },
      async LaunchSwapped(dao, key, event) {
        await dao.insertZeroSeedLaunchSwappedEvent(key, {
          coreAddress,
          ...event,
        });
      },
      async CreatorFeesClaimed(dao, key, event) {
        await dao.insertZeroSeedLaunchFeesClaimedEvent(key, {
          coreAddress,
          ...event,
        });
      },
    },
  };
}

/** The periphery's owner and payout events, attributed to its pinned extension. */
export function zeroSeedLaunchPeripheryHandlers(
  coreAddress: `0x${string}`,
  pin: Pick<ZeroSeedLaunchPin, "address">,
): Omit<ContractHandlers<typeof ZERO_SEED_LAUNCH_PERIPHERY_ABI>, "address"> {
  return {
    abi: ZERO_SEED_LAUNCH_PERIPHERY_ABI,
    handlers: {
      async LaunchOwnerChanged(dao, key, event) {
        await dao.insertZeroSeedLaunchOwnerChangedEvent(key, {
          coreAddress,
          extension: pin.address,
          ...event,
        });
      },
      async LaunchFeesClaimed(dao, key, event) {
        await dao.insertZeroSeedLaunchFeesPaidEvent(key, {
          coreAddress,
          extension: pin.address,
          ...event,
        });
      },
    },
  };
}

type FeeDecay =
  | { feeModel: "fixed_base_duration_v1"; feeDuration: number }
  | { feeModel: "tick_rate_v2"; decayRateX32: bigint };

async function insertLaunchCreated(
  dao: DAO,
  key: EventKey,
  event: LaunchCreated,
  coreAddress: `0x${string}`,
  decay: FeeDecay,
) {
  const problems = launchCreatedProblems(key, event);
  if (problems.length > 0)
    throw new Error(
      `Refusing LaunchCreated for pool ${event.poolId}: ${problems.join("; ")}`,
    );
  const { parameters } = event;
  await dao.insertZeroSeedLaunchCreatedEvent(key, {
    coreAddress,
    poolId: event.poolId,
    token: event.token,
    controller: event.controller,
    quoteToken: parameters.quoteToken,
    positionId: event.positionId,
    liquidity: event.liquidity,
    requestedSupply: parameters.supply,
    name: parameters.name,
    symbol: parameters.symbol,
    decimals: parameters.decimals,
    askTick: parameters.askTick,
    upperTick: parameters.upperTick,
    tickSpacing: parameters.tickSpacing,
    tradingStart: parameters.tradingStart,
    ...decay,
    initialFee: parameters.initialFee,
    finalFee: parameters.finalFee,
    salt: parameters.salt,
  });
}

/** Pure event decoding of a tick-rate (evm-contracts 3d6378f) extension. */
export function zeroSeedLaunchV2Handlers(
  coreAddress: `0x${string}`,
): Omit<ContractHandlers<typeof ZERO_SEED_LAUNCH_V2_ABI>, "address"> {
  return {
    abi: ZERO_SEED_LAUNCH_V2_ABI,
    handlers: {
      async LaunchCreated(dao, key, event) {
        await insertLaunchCreated(dao, key, event, coreAddress, {
          feeModel: "tick_rate_v2",
          decayRateX32: event.parameters.decayRateX32,
        });
      },
      async LaunchSwapped(dao, key, event) {
        await dao.insertZeroSeedLaunchSwappedEvent(key, {
          coreAddress,
          ...event,
        });
      },
      async CreatorFeesClaimed(dao, key, event) {
        await dao.insertZeroSeedLaunchFeesClaimedEvent(key, {
          coreAddress,
          ...event,
        });
      },
    },
  };
}

/** The tick-rate periphery's owner and payout events (unchanged events). */
export function zeroSeedLaunchPeripheryV2Handlers(
  coreAddress: `0x${string}`,
  pin: Pick<ZeroSeedLaunchPin, "address">,
): Omit<ContractHandlers<typeof ZERO_SEED_LAUNCH_PERIPHERY_V2_ABI>, "address"> {
  return {
    abi: ZERO_SEED_LAUNCH_PERIPHERY_V2_ABI,
    handlers: {
      async LaunchOwnerChanged(dao, key, event) {
        await dao.insertZeroSeedLaunchOwnerChangedEvent(key, {
          coreAddress,
          extension: pin.address,
          ...event,
        });
      },
      async LaunchFeesClaimed(dao, key, event) {
        await dao.insertZeroSeedLaunchFeesPaidEvent(key, {
          coreAddress,
          extension: pin.address,
          ...event,
        });
      },
    },
  };
}

/**
 * Refuses, once, before the first indexed block, to index a pinned instance
 * from a block after its deployment unless no launch event can have been
 * missed (see DAO.zeroSeedLaunchCatchUpProblem). The recovery is to roll back
 * to the block before the deployment and replay it inclusively.
 */
export function zeroSeedLaunchCatchUpGuard(
  pins: readonly Pick<
    ZeroSeedLaunchPin,
    "address" | "core" | "deploymentBlock"
  >[],
) {
  let checked = pins.length === 0;
  return async (dao: DAO, firstBlock: number) => {
    if (checked) return;
    for (const pin of pins) {
      const problem = await dao.zeroSeedLaunchCatchUpProblem(
        pin.core,
        pin.address,
        pin.deploymentBlock,
        firstBlock,
      );
      if (problem) throw new Error(problem);
    }
    checked = true;
  };
}
