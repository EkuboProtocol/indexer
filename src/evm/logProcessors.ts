import { DAO, type PoolInitializedInsert } from "../_shared/dao";
import type { EventKey } from "../_shared/eventKey";
import {
  CORE_ABI,
  INCENTIVES_ABI,
  ORACLE_ABI,
  ORDERS_ABI,
  POSITIONS_ABI,
  TOKEN_WRAPPER_FACTORY_ABI,
  TWAMM_ABI,
} from "./abis";
import {
  CORE_ABI as CORE_ABI_V3,
  INCENTIVES_ABI as INCENTIVES_ABI_V3,
  ORACLE_ABI as ORACLE_ABI_V3,
  ORDERS_ABI as ORDERS_ABI_V3,
  POSITIONS_ABI as POSITIONS_ABI_V3,
  TOKEN_WRAPPER_FACTORY_ABI as TOKEN_WRAPPER_FACTORY_ABI_V3,
  TWAMM_ABI as TWAMM_ABI_V3,
} from "./abis_v2";
import type {
  Abi,
  AbiParameterToPrimitiveType,
  ExtractAbiEvent,
  ExtractAbiEventNames,
} from "abitype";
import {
  type ContractEventName,
  decodeEventLog,
  encodeEventTopics,
} from "viem";
import { logger } from "../_shared/logger";
import {
  floatSqrtRatioToFixed,
  parseSwapEvent,
  parseSwapEventV3,
} from "./swapEvent";
import { parseOracleEvent } from "./oracleEvent";
import { parseTwammVirtualOrdersExecuted } from "./twammEvent";
import {
  parseOrderConfig,
  parsePoolBalanceUpdate,
  parsePoolKeyConfig,
  parsePositionId,
  parseV2PoolKeyConfig,
  toPoolConfigV2,
  toPoolId,
} from "./poolKey";
import {
  calculateSwapProtocolFeeDelta,
  calculateWithdrawalProtocolFeeDelta,
  EVM_POOL_FEE_DENOMINATOR,
} from "./protocolFees";
import type { PositionsContractProtocolFeeConfig } from "./positionsProtocolFeeConfig";

export type ContractEvent<
  abi extends Abi,
  N extends ExtractAbiEventNames<abi>
> = {
  [P in ExtractAbiEvent<abi, N>["inputs"][number] as P extends {
    name: infer N extends string;
  }
    ? N
    : never]: AbiParameterToPrimitiveType<P>;
};

interface EvmLogProcessor {
  address: `0x${string}`;

  filter: {
    topics: (`0x${string}` | null)[];
    strict: boolean;
  };

  handler: (
    dao: DAO,
    key: EventKey,
    event: {
      topics: readonly `0x${string}`[];
      data: `0x${string}` | undefined;
    }
  ) => Promise<void>;
}

function createContractEventProcessor<
  T extends Abi,
  N extends ContractEventName<T>
>({
  contractName,
  address,
  abi,
  eventName,
  handler: wrappedHandler,
}: {
  contractName: string;
  address: `0x${string}`;
  abi: T;
  eventName: N;
  handler(dao: DAO, key: EventKey, event: ContractEvent<T, N>): Promise<void>;
}): EvmLogProcessor {
  return {
    address,
    filter: {
      topics: encodeEventTopics({
        abi,
        eventName,
      } as any) as `0x${string}`[],
      strict: false,
    },
    async handler(dao, key, event) {
      if (event.topics.length === 0)
        throw new Error(`Event matched ${eventName} filter with no topics`);

      const result = decodeEventLog({
        abi,
        eventName: eventName,
        topics: event.topics as [`0x${string}`, ...topics: `0x${string}`[]],
        data: event.data,
        strict: true,
      });

      logger.debug(`Processing ${contractName}.${eventName}`, {
        key,
        event: result.args,
      });
      await wrappedHandler(dao, key, result.args as any);
    },
  };
}

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

type HandlerMap<T extends Abi> = {
  [eventName in ContractEventName<T>]?: Parameters<
    typeof createContractEventProcessor<T, eventName>
  >[0]["handler"];
};

type ContractHandlers<T extends Abi> = {
  address: `0x${string}`;
  abi: T;
  handlers?: HandlerMap<T>;
  noTopics?: (
    dao: DAO,
    key: EventKey,
    data: `0x${string}` | undefined
  ) => Promise<void>;
};

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

export interface LogProcessorConfigV3
  extends Omit<LogProcessorConfigV2, "positionsAddress"> {
  positionsContracts: PositionsContractProtocolFeeConfig[];
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

type ProcessorDefinitionsV3 = {
  Core: ContractHandlers<typeof CORE_ABI_V3>;
  Oracle: ContractHandlers<typeof ORACLE_ABI_V3>;
  TWAMM: ContractHandlers<typeof TWAMM_ABI_V3>;
  Orders: ContractHandlers<typeof ORDERS_ABI_V3>;
  Incentives: ContractHandlers<typeof INCENTIVES_ABI_V3>;
  TokenWrapperFactory: ContractHandlers<typeof TOKEN_WRAPPER_FACTORY_ABI_V3>;
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
        logger.debug(`Parsed Swapped Event`, {
          event,
          rawData: data,
        });
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
          await dao.insertPositionUpdatedEventV2(parsed, key);
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
        logger.debug(`Parsed Oracle Event`, {
          event,
          rawData: data,
        });
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
        logger.debug(`Parsed TWAMM Event`, {
          event,
          rawData: data,
        });
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

  return Object.entries(processors).flatMap(
    ([contractName, { address, abi, handlers, noTopics }]) =>
      (noTopics
        ? [
            <EvmLogProcessor>{
              address,
              filter: {
                topics: [],
                strict: true,
              },
              handler(dao, eventKey, log): Promise<void> {
                return noTopics(dao, eventKey, log.data);
              },
            },
          ]
        : []
      ).concat(
        handlers
          ? Object.entries(handlers).map(
              ([eventName, handler]): EvmLogProcessor =>
                createContractEventProcessor({
                  contractName,
                  address,
                  abi,
                  eventName: eventName as ExtractAbiEventNames<typeof abi>,
                  handler: handler as any,
                })
            )
          : []
      )
  ) as EvmLogProcessor[];
}

export function createLogProcessorsV3({
  mevCaptureAddress,
  coreAddress,
  oracleAddress,
  twammAddress,
  ordersAddress,
  incentivesAddress,
  tokenWrapperFactoryAddress,
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

  const processors: ProcessorDefinitionsV3 = {
    Core: {
      address: coreAddress,
      abi: CORE_ABI_V3,
      async noTopics(dao, key, data) {
        if (!data) throw new Error("Event with no data from core");
        const event = parseSwapEventV3(data);
        logger.debug(`Parsed Swapped Event`, {
          event,
          rawData: data,
        });
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
            parsed.balanceUpdate
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

          await dao.insertPositionUpdatedEvent(positionUpdate, key);

          const lockerConfig = positionsConfigMap.get(BigInt(parsed.locker));
          const liquidityDelta = BigInt(parsed.liquidityDelta);
          const withdrawalProtocolFee =
            lockerConfig &&
            lockerConfig.swapProtocolFee > 0n &&
            lockerConfig.withdrawalProtocolFeeDivisor > 0n
              ? lockerConfig.swapProtocolFee /
                lockerConfig.withdrawalProtocolFeeDivisor
              : 0n;

          if (
            liquidityDelta < 0n &&
            withdrawalProtocolFee > 0n &&
            withdrawalProtocolFee < EVM_POOL_FEE_DENOMINATOR
          ) {
            const protocolDelta0 = calculateWithdrawalProtocolFeeDelta(
              delta0,
              withdrawalProtocolFee
            );
            const protocolDelta1 = calculateWithdrawalProtocolFeeDelta(
              delta1,
              withdrawalProtocolFee
            );

            if (protocolDelta0 !== 0n || protocolDelta1 !== 0n) {
              await dao.insertProtocolFeesPaid(
                {
                  locker: parsed.locker,
                  poolId: parsed.poolId,
                  salt: params.salt,
                  bounds: { lower: params.lower, upper: params.upper },
                  delta0: protocolDelta0,
                  delta1: protocolDelta1,
                },
                key
              );
            }
          } else if (
            liquidityDelta < 0n &&
            withdrawalProtocolFee >= EVM_POOL_FEE_DENOMINATOR &&
            lockerConfig
          ) {
            logger.warn("Skipping withdrawal protocol fee >= denominator", {
              locker: lockerConfig.address,
              withdrawalProtocolFee,
            });
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
            key
          );

          const lockerProtocolFeeConfig = positionsConfigMap.get(
            BigInt(parsed.locker)
          );

          if (
            lockerProtocolFeeConfig &&
            lockerProtocolFeeConfig.swapProtocolFee > 0n
          ) {
            const protocolDelta0 = calculateSwapProtocolFeeDelta(
              parsed.amount0,
              lockerProtocolFeeConfig.swapProtocolFee
            );
            const protocolDelta1 = calculateSwapProtocolFeeDelta(
              parsed.amount1,
              lockerProtocolFeeConfig.swapProtocolFee
            );

            if (protocolDelta0 !== 0n || protocolDelta1 !== 0n) {
              await dao.insertProtocolFeesPaid(
                {
                  locker: parsed.locker,
                  poolId: parsed.poolId,
                  salt: params.salt,
                  bounds: { lower: params.lower, upper: params.upper },
                  delta0: protocolDelta0,
                  delta1: protocolDelta1,
                },
                key
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
        logger.debug(`Parsed Oracle Event`, {
          event,
          rawData: data,
        });
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
      abi: TWAMM_ABI_V3,
      async noTopics(dao, key, data) {
        if (!data) throw new Error("Event with no data from TWAMM");
        const event = parseTwammVirtualOrdersExecuted(data);
        logger.debug(`Parsed TWAMM Event`, {
          event,
          rawData: data,
        });
        await dao.insertTWAMMVirtualOrdersExecutedEvent(
          { ...event, coreAddress },
          key
        );
      },
      handlers: {
        async OrderUpdated(dao, key, parsed) {
          const { startTime, endTime, fee, isToken1 } = parseOrderConfig(
            parsed.orderKey.config
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
            key
          );
        },
        async OrderProceedsWithdrawn(dao, key, parsed) {
          const { startTime, endTime, fee, isToken1 } = parseOrderConfig(
            parsed.orderKey.config
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
            key
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
  };

  return Object.entries(processors).flatMap(
    ([contractName, { address, abi, handlers, noTopics }]) =>
      (noTopics
        ? [
            <EvmLogProcessor>{
              address,
              filter: {
                topics: [],
                strict: true,
              },
              handler(dao, eventKey, log): Promise<void> {
                return noTopics(dao, eventKey, log.data);
              },
            },
          ]
        : []
      ).concat(
        handlers
          ? Object.entries(handlers).map(
              ([eventName, handler]): EvmLogProcessor =>
                createContractEventProcessor({
                  contractName,
                  address,
                  abi,
                  eventName: eventName as ExtractAbiEventNames<typeof abi>,
                  handler: handler as any,
                })
            )
          : []
      )
  ) as EvmLogProcessor[];
}
