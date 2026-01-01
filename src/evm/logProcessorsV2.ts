import type { PoolInitializedInsert } from "../_shared/dao";
import { floatSqrtRatioToFixed, parseSwapEvent } from "./swapEvent";
import { parseOracleEvent } from "./oracleEvent";
import { parseTwammVirtualOrdersExecuted } from "./twammEvent";
import { parsePoolKeyConfig, toPoolConfigV2, toPoolId } from "./poolKey";
import { EVM_POOL_FEE_DENOMINATOR } from "./protocolFees";
import {
  createProcessorsFromHandlers,
  type ContractHandlers,
  type EvmLogProcessor,
} from "./logProcessorsShared";
import {
  CORE_ABI,
  INCENTIVES_ABI,
  ORACLE_ABI,
  ORDERS_ABI,
  POSITIONS_ABI,
  TOKEN_WRAPPER_FACTORY_ABI,
  TWAMM_ABI,
} from "./abis_v2";

/**
 * Makes the V2 pool key match what we use for V3
 */
export function normalizeV2PoolKey({
  token0,
  token1,
  fee,
  tickSpacing,
  extension,
  poolConfig,
}: {
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: bigint;
  tickSpacing: number;
  extension: `0x${string}`;
  poolConfig: bigint;
}): PoolInitializedInsert["poolKey"] {
  const isLegacyStableswap = tickSpacing === 0;

  return {
    token0,
    token1,
    fee,
    tickSpacing: isLegacyStableswap ? null : tickSpacing,
    extension,
    poolConfig,
    poolConfigType: isLegacyStableswap ? "stableswap" : "concentrated",
    stableswapCenterTick: isLegacyStableswap ? 0 : null,
    stableswapAmplification: isLegacyStableswap ? 0 : null,
  };
}

export interface LogProcessorConfigV2 {
  mevCaptureAddress: `0x${string}`;
  coreAddress: `0x${string}`;
  positionsAddress: `0x${string}`;
  oracleAddress: `0x${string}`;
  twammAddress: `0x${string}`;
  ordersAddress: `0x${string}`;
  incentivesAddress: `0x${string}`;
  tokenWrapperFactoryAddress: `0x${string}`;
}

type ProcessorDefinitionsV2 = {
  Core: ContractHandlers<typeof CORE_ABI>;
  Positions: ContractHandlers<typeof POSITIONS_ABI>;
  Oracle: ContractHandlers<typeof ORACLE_ABI>;
  TWAMM: ContractHandlers<typeof TWAMM_ABI>;
  Orders: ContractHandlers<typeof ORDERS_ABI>;
  Incentives: ContractHandlers<typeof INCENTIVES_ABI>;
  TokenWrapperFactory: ContractHandlers<typeof TOKEN_WRAPPER_FACTORY_ABI>;
};

export function createLogProcessorsV2({
  mevCaptureAddress,
  coreAddress,
  positionsAddress,
  oracleAddress,
  twammAddress,
  ordersAddress,
  incentivesAddress,
  tokenWrapperFactoryAddress,
}: LogProcessorConfigV2): EvmLogProcessor[] {
  const mevCaptureAddressBigInt = BigInt(mevCaptureAddress);

  const processors: ProcessorDefinitionsV2 = {
    Core: {
      address: coreAddress,
      abi: CORE_ABI,
      async noTopics(dao, key, data) {
        if (!data) throw new Error("Event with no data from core");
        const event = parseSwapEvent(data);
        await dao.insertSwappedEvent(event, key);
      },
      handlers: {
        async PoolInitialized(dao, key, parsed) {
          const { fee, tickSpacing, extension } = parsePoolKeyConfig(
            parsed.poolKey.config
          );
          const poolConfigWord = BigInt(parsed.poolKey.config);
          const poolInitialized: PoolInitializedInsert = {
            feeDenominator: EVM_POOL_FEE_DENOMINATOR,
            poolKey: normalizeV2PoolKey({
              token0: parsed.poolKey.token0,
              token1: parsed.poolKey.token1,
              fee,
              tickSpacing,
              extension,
              poolConfig: poolConfigWord,
            }),
            poolId: parsed.poolId,
            tick:
              typeof parsed.tick === "bigint"
                ? Number(parsed.tick)
                : parsed.tick,
            sqrtRatio: floatSqrtRatioToFixed(parsed.sqrtRatio),
          };
          await dao.insertPoolInitializedEvent(poolInitialized, key);

          if (BigInt(extension) === mevCaptureAddressBigInt) {
            await dao.insertMEVCapturePoolKey(key.emitter, parsed.poolId);
          }
        },
        async PositionUpdated(dao, key, parsed) {
          await dao.insertPositionUpdatedEventWithSyntheticProtocolFeesPaid(
            parsed,
            key
          );
        },
        async PositionFeesCollected(dao, key, parsed) {
          await dao.insertPositionFeesCollectedEvent(parsed, key);
        },
        async ProtocolFeesWithdrawn(dao, key, parsed) {
          await dao.insertProtocolFeesWithdrawn(parsed, key);
        },
        async FeesAccumulated(dao, key, parsed) {
          await dao.insertFeesAccumulatedEvent(parsed, key);
        },
        async ExtensionRegistered(dao, key, parsed) {
          await dao.insertExtensionRegistered(parsed, key);
        },
      },
    },
    Positions: {
      address: positionsAddress,
      abi: POSITIONS_ABI,
      handlers: {
        async Transfer(dao, key, parsed) {
          await dao.insertNonfungibleTokenTransferEvent(parsed, key);
        },
      },
    },
    Oracle: {
      address: oracleAddress,
      abi: ORACLE_ABI,
      async noTopics(dao, key, data) {
        if (!data) throw new Error("Event with no data from Oracle");
        const event = parseOracleEvent(data);

        await dao.insertOracleSnapshotEvent(
          {
            token0: "0x0000000000000000000000000000000000000000",
            token1: event.token,

            secondsPerLiquidityCumulative: event.secondsPerLiquidityCumulative,
            tickCumulative: event.tickCumulative,
            timestamp: event.timestamp,
          },
          key
        );
      },
    },
    TWAMM: {
      address: twammAddress,
      abi: TWAMM_ABI,
      async noTopics(dao, key, data) {
        if (!data) throw new Error("Event with no data from TWAMM");
        const event = parseTwammVirtualOrdersExecuted(data);
        await dao.insertTWAMMVirtualOrdersExecutedEvent(
          { ...event, coreAddress },
          key
        );
      },
      handlers: {
        async OrderUpdated(dao, key, parsed) {
          const [token0, token1] =
            BigInt(parsed.orderKey.sellToken) < BigInt(parsed.orderKey.buyToken)
              ? [parsed.orderKey.sellToken, parsed.orderKey.buyToken]
              : [parsed.orderKey.buyToken, parsed.orderKey.sellToken];

          await dao.insertTWAMMOrderUpdatedEvent(
            {
              ...parsed,
              coreAddress,
              poolId: toPoolId({
                token0,
                token1,
                config: toPoolConfigV2({
                  fee: BigInt(parsed.orderKey.fee),
                  tickSpacing: 0,
                  extension: key.emitter,
                }),
              }),
              is_selling_token1:
                BigInt(parsed.orderKey.sellToken) >
                BigInt(parsed.orderKey.buyToken),
            },
            key
          );
        },
        async OrderProceedsWithdrawn(dao, key, parsed) {
          const [token0, token1] =
            BigInt(parsed.orderKey.sellToken) < BigInt(parsed.orderKey.buyToken)
              ? [parsed.orderKey.sellToken, parsed.orderKey.buyToken]
              : [parsed.orderKey.buyToken, parsed.orderKey.sellToken];

          await dao.insertTWAMMOrderProceedsWithdrawnEvent(
            {
              ...parsed,
              coreAddress,
              poolId: toPoolId({
                token0,
                token1,
                config: toPoolConfigV2({
                  fee: BigInt(parsed.orderKey.fee),
                  tickSpacing: 0,
                  extension: key.emitter,
                }),
              }),
              is_selling_token1:
                BigInt(parsed.orderKey.sellToken) >
                BigInt(parsed.orderKey.buyToken),
            },
            key
          );
        },
      },
    },
    Orders: {
      address: ordersAddress,
      abi: ORDERS_ABI,
      handlers: {
        async Transfer(dao, key, parsed) {
          await dao.insertNonfungibleTokenTransferEvent(parsed, key);
        },
      },
    },
    Incentives: {
      address: incentivesAddress,
      abi: INCENTIVES_ABI,
      handlers: {
        async Funded(dao, key, event) {
          await dao.insertIncentivesFundedEvent(key, event);
        },
        async Refunded(dao, key, event) {
          await dao.insertIncentivesRefundedEvent(key, event);
        },
      },
    },
    TokenWrapperFactory: {
      address: tokenWrapperFactoryAddress,
      abi: TOKEN_WRAPPER_FACTORY_ABI,
      handlers: {
        async TokenWrapperDeployed(dao, key, event) {
          await dao.insertTokenWrapperDeployed(key, event);
        },
      },
    },
  };

  return createProcessorsFromHandlers(processors as any);
}
