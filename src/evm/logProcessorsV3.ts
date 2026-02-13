import type { PoolInitializedInsert } from "../_shared/dao";
import { floatSqrtRatioToFixed, parseSwapEventV3 } from "./swapEvent";
import { parseOracleEvent } from "./oracleEvent";
import { parseTwammVirtualOrdersExecuted } from "./twammEvent";
import {
  parseOrderConfig,
  parsePoolBalanceUpdate,
  parsePositionId,
  parseV2PoolKeyConfig,
  toPoolConfigV2,
  toPoolId,
} from "./poolKey";
import { computeFee, EVM_POOL_FEE_DENOMINATOR } from "./protocolFees";
import type { PositionsContractProtocolFeeConfig } from "./positionsProtocolFeeConfig";
import {
  createContractEventProcessor,
  createProcessorsFromHandlers,
  type ContractHandlers,
  type EvmLogProcessor,
} from "./logProcessorsShared";
import {
  AUCTIONS_ABI as AUCTIONS_ABI_V3,
  CORE_ABI as CORE_ABI_V3,
  INCENTIVES_ABI as INCENTIVES_ABI_V3,
  ORACLE_ABI as ORACLE_ABI_V3,
  ORDERS_ABI as ORDERS_ABI_V3,
  POSITIONS_ABI as POSITIONS_ABI_V3,
  TOKEN_WRAPPER_FACTORY_ABI as TOKEN_WRAPPER_FACTORY_ABI_V3,
  TWAMM_ABI as TWAMM_ABI_V3,
  BOOSTED_FEES_ABI as BOOSTED_FEES_ABI_V3,
} from "./abis_v3";

export interface LogProcessorConfigV3 {
  mevCaptureAddress: `0x${string}`;
  boostedFeesConcentratedAddress: `0x${string}`;
  boostedFeesStableswapAddress: `0x${string}`;
  coreAddress: `0x${string}`;
  oracleAddress: `0x${string}`;
  twammAddress: `0x${string}`;
  ordersAddress: `0x${string}`;
  incentivesAddress: `0x${string}`;
  tokenWrapperFactoryAddress: `0x${string}`;
  auctionsAddress: `0x${string}`;
  positionsContracts: PositionsContractProtocolFeeConfig[];
}

type ProcessorDefinitionsV3 = {
  Core: ContractHandlers<typeof CORE_ABI_V3>;
  Oracle: ContractHandlers<typeof ORACLE_ABI_V3>;
  TWAMM: ContractHandlers<typeof TWAMM_ABI_V3>;
  Orders: ContractHandlers<typeof ORDERS_ABI_V3>;
  Incentives: ContractHandlers<typeof INCENTIVES_ABI_V3>;
  TokenWrapperFactory: ContractHandlers<typeof TOKEN_WRAPPER_FACTORY_ABI_V3>;
  BoostedFeesConcentrated: ContractHandlers<typeof BOOSTED_FEES_ABI_V3>;
  BoostedFeesStableswap: ContractHandlers<typeof BOOSTED_FEES_ABI_V3>;
  Auctions?: ContractHandlers<typeof AUCTIONS_ABI_V3>;
};

export function createLogProcessorsV3({
  mevCaptureAddress,
  boostedFeesConcentratedAddress,
  boostedFeesStableswapAddress,
  coreAddress,
  oracleAddress,
  twammAddress,
  ordersAddress,
  incentivesAddress,
  tokenWrapperFactoryAddress,
  auctionsAddress,
  positionsContracts,
}: LogProcessorConfigV3): EvmLogProcessor[] {
  const mevCaptureAddressBigInt = BigInt(mevCaptureAddress);

  const positionsConfigMap = new Map<
    bigint,
    PositionsContractProtocolFeeConfig
  >();

  for (const config of positionsContracts ?? []) {
    positionsConfigMap.set(BigInt(config.address), config);
  }

  const boostedFeesHandler: Pick<
    ContractHandlers<typeof BOOSTED_FEES_ABI_V3>,
    "abi" | "handlers" | "noTopics"
  > = {
    abi: BOOSTED_FEES_ABI_V3,
    async noTopics(dao, key, data) {
      if (!data) throw new Error("Event with no data from BoostedFees");
      const event = parseTwammVirtualOrdersExecuted(data);
      await dao.insertBoostedFeesDonatedEvent(
        {
          coreAddress,
          poolId: event.poolId,
          donateRate0: event.saleRateToken0,
          donateRate1: event.saleRateToken1,
        },
        key,
      );
    },
    handlers: {
      async PoolBoosted(dao, key, parsed) {
        await dao.insertBoostedFeesPoolBoostedEvent(
          {
            coreAddress,
            poolId: parsed.poolId,
            startTime: parsed.startTime,
            endTime: parsed.endTime,
            rate0: parsed.rate0,
            rate1: parsed.rate1,
          },
          key,
        );
      },
    },
  };

  const processors: ProcessorDefinitionsV3 = {
    Core: {
      address: coreAddress,
      abi: CORE_ABI_V3,
      async noTopics(dao, key, data) {
        if (!data) throw new Error("Event with no data from core");
        const event = parseSwapEventV3(data);
        await dao.insertSwappedEvent(event, key);
      },
      handlers: {
        async PoolInitialized(dao, key, parsed) {
          const parsedConfig = parseV2PoolKeyConfig(parsed.poolKey.config);
          const poolConfigWord = BigInt(parsed.poolKey.config);
          const isConcentrated = "tickSpacing" in parsedConfig;
          const poolInitialized: PoolInitializedInsert = {
            feeDenominator: EVM_POOL_FEE_DENOMINATOR,
            poolKey: {
              token0: parsed.poolKey.token0,
              token1: parsed.poolKey.token1,
              fee: parsedConfig.fee,
              tickSpacing: isConcentrated ? parsedConfig.tickSpacing : null,
              extension: parsedConfig.extension,
              poolConfig: poolConfigWord,
              poolConfigType: isConcentrated ? "concentrated" : "stableswap",
              stableswapCenterTick: isConcentrated
                ? null
                : parsedConfig.centerTick,
              stableswapAmplification: isConcentrated
                ? null
                : parsedConfig.amplificationFactor,
            },
            poolId: parsed.poolId,
            tick:
              typeof parsed.tick === "bigint"
                ? Number(parsed.tick)
                : parsed.tick,
            sqrtRatio: floatSqrtRatioToFixed(parsed.sqrtRatio),
          };
          await dao.insertPoolInitializedEvent(poolInitialized, key);

          if (BigInt(parsedConfig.extension) === mevCaptureAddressBigInt) {
            await dao.insertMEVCapturePoolKey(key.emitter, parsed.poolId);
          }
        },
        async PositionUpdated(dao, key, parsed) {
          const params = parsePositionId(parsed.positionId);
          const { delta0, delta1 } = parsePoolBalanceUpdate(
            parsed.balanceUpdate,
          );
          const positionUpdate = {
            params: {
              bounds: {
                lower: params.lower,
                upper: params.upper,
              },
              liquidityDelta: parsed.liquidityDelta,
              salt: params.salt,
            },
            delta0,
            delta1,
            locker: parsed.locker,
            poolId: parsed.poolId,
          };

          const withdrawalProtocolFee = positionsConfigMap.get(
            BigInt(parsed.locker),
          )?.withdrawalProtocolFeeDivisor;

          await dao.insertPositionUpdatedEvent(positionUpdate, key);

          if (
            withdrawalProtocolFee &&
            withdrawalProtocolFee > 0n &&
            (delta0 < 0n || delta1 < 0n)
          ) {
            const withdrawalAmount0 = delta0 < 0n ? -delta0 : 0n;
            const withdrawalAmount1 = delta1 < 0n ? -delta1 : 0n;

            await dao.insertPositionWithdrawalFeesWithheld(
              {
                poolId: parsed.poolId,
                locker: parsed.locker,
                salt: params.salt,
                bounds: { lower: params.lower, upper: params.upper },
                amount0: withdrawalAmount0,
                amount1: withdrawalAmount1,
                withdrawalProtocolFeeDivisor: withdrawalProtocolFee,
              },
              key,
            );
          }
        },
        async PositionFeesCollected(dao, key, parsed) {
          const params = parsePositionId(parsed.positionId);
          await dao.insertPositionFeesCollectedEvent(
            {
              amount0: parsed.amount0,
              amount1: parsed.amount1,
              poolId: parsed.poolId,
              positionKey: {
                bounds: { lower: params.lower, upper: params.upper },
                owner: parsed.locker,
                salt: params.salt,
              },
            },
            key,
          );

          const swapProtocolFee = positionsConfigMap.get(
            BigInt(parsed.locker),
          )?.swapProtocolFee;

          if (swapProtocolFee && swapProtocolFee > 0n) {
            const protocolFee0 = computeFee(parsed.amount0, swapProtocolFee);
            const protocolFee1 = computeFee(parsed.amount1, swapProtocolFee);

            if (protocolFee0 !== 0n || protocolFee1 !== 0n) {
              await dao.insertPositionFeesWithheld(
                {
                  poolId: parsed.poolId,
                  locker: parsed.locker,
                  salt: params.salt,
                  bounds: { lower: params.lower, upper: params.upper },
                  amount0: protocolFee0,
                  amount1: protocolFee1,
                },
                key,
              );
            }
          }
        },
        async FeesAccumulated(dao, key, parsed) {
          await dao.insertFeesAccumulatedEvent(parsed, key);
        },
        async ExtensionRegistered(dao, key, parsed) {
          await dao.insertExtensionRegistered(parsed, key);
        },
      },
    },
    Oracle: {
      address: oracleAddress,
      abi: ORACLE_ABI_V3,
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
          key,
        );
      },
    },
    TWAMM: {
      address: twammAddress,
      abi: TWAMM_ABI_V3,
      async noTopics(dao, key, data) {
        if (!data) throw new Error("Event with no data from TWAMM");
        const event = parseTwammVirtualOrdersExecuted(data);
        await dao.insertTWAMMVirtualOrdersExecutedEvent(
          { ...event, coreAddress },
          key,
        );
      },
      handlers: {
        async OrderUpdated(dao, key, parsed) {
          const { startTime, endTime, fee, isToken1 } = parseOrderConfig(
            parsed.orderKey.config,
          );
          const [buyToken, sellToken] = isToken1
            ? [parsed.orderKey.token0, parsed.orderKey.token1]
            : [parsed.orderKey.token1, parsed.orderKey.token0];
          await dao.insertTWAMMOrderUpdatedEvent(
            {
              coreAddress,
              orderKey: {
                buyToken,
                sellToken,
                startTime,
                endTime,
                fee,
              },
              poolId: toPoolId({
                token0: parsed.orderKey.token0,
                token1: parsed.orderKey.token1,
                // v2 and v3 behavior match as long as tickSpacing == 0n
                config: toPoolConfigV2({
                  fee,
                  tickSpacing: 0,
                  extension: key.emitter,
                }),
              }),
              owner: parsed.owner,
              salt: parsed.salt,
              saleRateDelta: parsed.saleRateDelta,
              is_selling_token1: isToken1,
            },
            key,
          );
        },
        async OrderProceedsWithdrawn(dao, key, parsed) {
          const { startTime, endTime, fee, isToken1 } = parseOrderConfig(
            parsed.orderKey.config,
          );
          const [buyToken, sellToken] = isToken1
            ? [parsed.orderKey.token0, parsed.orderKey.token1]
            : [parsed.orderKey.token1, parsed.orderKey.token0];

          await dao.insertTWAMMOrderProceedsWithdrawnEvent(
            {
              coreAddress,
              orderKey: {
                buyToken,
                sellToken,
                startTime,
                endTime,
                fee,
              },
              poolId: toPoolId({
                token0: parsed.orderKey.token0,
                token1: parsed.orderKey.token1,
                // v2 and v3 behavior match as long as tickSpacing == 0n
                config: toPoolConfigV2({
                  fee,
                  tickSpacing: 0,
                  extension: key.emitter,
                }),
              }),
              owner: parsed.owner,
              salt: parsed.salt,
              amount: parsed.amount,
              is_selling_token1: isToken1,
            },
            key,
          );
        },
      },
    },
    Orders: {
      address: ordersAddress,
      abi: ORDERS_ABI_V3,
      handlers: {
        async Transfer(dao, key, parsed) {
          await dao.insertNonfungibleTokenTransferEvent(parsed, key);
        },
      },
    },
    Incentives: {
      address: incentivesAddress,
      abi: INCENTIVES_ABI_V3,
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
      abi: TOKEN_WRAPPER_FACTORY_ABI_V3,
      handlers: {
        async TokenWrapperDeployed(dao, key, event) {
          await dao.insertTokenWrapperDeployed(key, event);
        },
      },
    },
    BoostedFeesConcentrated: {
      address: boostedFeesConcentratedAddress,
      ...boostedFeesHandler,
    },
    BoostedFeesStableswap: {
      address: boostedFeesStableswapAddress,
      ...boostedFeesHandler,
    },
    ...(auctionsAddress
      ? {
          Auctions: {
            address: auctionsAddress,
            abi: AUCTIONS_ABI_V3,
            handlers: {
              async Transfer(dao, key, parsed) {
                await dao.insertNonfungibleTokenTransferEvent(parsed, key);
              },
              async AuctionCompleted(dao, key, parsed) {
                await dao.insertAuctionCompletedEvent(parsed, key);
              },
              async AuctionFundsAdded(dao, key, parsed) {
                await dao.insertAuctionFundsAddedEvent(parsed, key);
              },
              async BoostStarted(dao, key, parsed) {
                await dao.insertAuctionBoostStartedEvent(parsed, key);
              },
              async CreatorProceedsCollected(dao, key, parsed) {
                await dao.insertCreatorProceedsCollectedEvent(parsed, key);
              },
            },
          },
        }
      : {}),
  };

  const baseProcessors = createProcessorsFromHandlers(processors as any);

  const positionsProcessors =
    positionsContracts?.flatMap((p) =>
      createContractEventProcessor({
        contractName: "Positions",
        address: p.address,
        abi: POSITIONS_ABI_V3,
        eventName: "Transfer",
        async handler(dao, event, key) {
          await dao.insertNonfungibleTokenTransferEvent(key, event);
        },
      }),
    ) ?? [];

  return baseProcessors.concat(positionsProcessors);
}
