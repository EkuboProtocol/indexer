import type { EventKey } from "../_shared/eventKey";
import { ZERO_SEED_LAUNCH_ABI } from "./abis_zero_seed_launch";
import {
  createProcessorsFromHandlers,
  type ContractEvent,
  type EvmLogProcessor,
} from "./logProcessorsShared";
import { parsePositionId, parseV2PoolKeyConfig, toPoolId } from "./poolKey";

type LaunchCreated = ContractEvent<
  typeof ZERO_SEED_LAUNCH_ABI,
  "LaunchCreated"
>;

const same = (a: string, b: string) => BigInt(a) === BigInt(b);

/**
 * Reasons a LaunchCreated log disagrees with itself or its emitter. The stored
 * row derives the position's pool ticks from the economic ticks and the token
 * order, so the log's own pool key and position id must say the same thing.
 */
export function launchCreatedProblems(
  key: Pick<EventKey, "emitter">,
  event: LaunchCreated,
): string[] {
  const { poolKey, parameters, positionId } = event;
  const config = parseV2PoolKeyConfig(poolKey.config);
  const tokenIs0 = BigInt(event.token) < BigInt(parameters.quoteToken);
  const [token0, token1] = tokenIs0
    ? [event.token, parameters.quoteToken]
    : [parameters.quoteToken, event.token];
  const position = parsePositionId(positionId);
  const [lower, upper] = tokenIs0
    ? [parameters.askTick, parameters.upperTick]
    : [-parameters.upperTick, -parameters.askTick];

  return [
    [parameters.liquidity === event.liquidity, "parameters.liquidity != liquidity"],
    [same(config.extension, key.emitter), "pool extension is not the emitter"],
    [toPoolId(poolKey) === event.poolId.toLowerCase(), "poolId != id of poolKey"],
    [same(poolKey.token0, token0) && same(poolKey.token1, token1), "pool tokens are not (token, quoteToken) in order"],
    [config.fee === 0n, "Core fee is not 0"],
    ["tickSpacing" in config && config.tickSpacing === parameters.tickSpacing, "tick spacing differs"],
    [position.salt === 0n && position.lower === lower && position.upper === upper, "position is not (salt 0, tick_lower, tick_upper)"],
  ]
    .filter(([ok]) => !ok)
    .map(([, problem]) => problem as string);
}

/** ZeroSeedLaunch's three events, decoded with the frozen ABI. */
export function createZeroSeedLaunchProcessors({
  coreAddress,
  zeroSeedLaunchAddress,
}: {
  coreAddress: `0x${string}`;
  zeroSeedLaunchAddress?: `0x${string}`;
}): EvmLogProcessor[] {
  if (!zeroSeedLaunchAddress) return [];

  return createProcessorsFromHandlers({
    ZeroSeedLaunch: {
      address: zeroSeedLaunchAddress,
      abi: ZERO_SEED_LAUNCH_ABI,
      handlers: {
        async LaunchCreated(dao, key, event) {
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
            creator: event.creator,
            quoteToken: parameters.quoteToken,
            positionId: event.positionId,
            liquidity: event.liquidity,
            supply: parameters.supply,
            name: parameters.name,
            symbol: parameters.symbol,
            decimals: parameters.decimals,
            askTick: parameters.askTick,
            upperTick: parameters.upperTick,
            tickSpacing: parameters.tickSpacing,
            tradingStart: parameters.tradingStart,
            feeDuration: parameters.feeDuration,
            initialFee: parameters.initialFee,
            finalFee: parameters.finalFee,
            salt: parameters.salt,
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
    },
  });
}
