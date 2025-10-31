import { DAO, type PoolInitializedInsert } from "../_shared/dao.ts";
import type { EventKey } from "../_shared/eventKey.ts";
import {
  CORE_ABI,
  INCENTIVES_ABI,
  ORACLE_ABI,
  ORDERS_ABI,
  POSITIONS_ABI,
  TOKEN_WRAPPER_FACTORY_ABI,
  TWAMM_ABI,
} from "./abis.ts";
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
import { logger } from "../_shared/logger.ts";
import { floatSqrtRatioToFixed, parseSwapEvent } from "./swapEvent.ts";
import { parseOracleEvent } from "./oracleEvent.ts";
import { parseTwammVirtualOrdersExecuted } from "./twammEvent.ts";
import { parsePoolKeyConfig, toPoolConfig, toPoolId } from "./poolKey.ts";

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

const EVM_POOL_FEE_DENOMINATOR = 1n << 64n;

export interface LogProcessorConfig {
  mevCaptureAddress: `0x${string}`;
  coreAddress: `0x${string}`;
  positionsAddress: `0x${string}`;
  oracleAddress: `0x${string}`;
  twammAddress: `0x${string}`;
  ordersAddress: `0x${string}`;
  incentivesAddress: `0x${string}`;
  tokenWrapperFactoryAddress: `0x${string}`;
}

type ProcessorDefinitions = {
  Core: ContractHandlers<typeof CORE_ABI>;
  Positions: ContractHandlers<typeof POSITIONS_ABI>;
  Oracle: ContractHandlers<typeof ORACLE_ABI>;
  TWAMM: ContractHandlers<typeof TWAMM_ABI>;
  Orders: ContractHandlers<typeof ORDERS_ABI>;
  Incentives: ContractHandlers<typeof INCENTIVES_ABI>;
  TokenWrapperFactory: ContractHandlers<typeof TOKEN_WRAPPER_FACTORY_ABI>;
};

export function createLogProcessors({
  mevCaptureAddress,
  coreAddress,
  positionsAddress,
  oracleAddress,
  twammAddress,
  ordersAddress,
  incentivesAddress,
  tokenWrapperFactoryAddress,
}: LogProcessorConfig): EvmLogProcessor[] {
  const mevCaptureAddressBigInt = BigInt(mevCaptureAddress);

  const processors: ProcessorDefinitions = {
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
          const poolInitialized: PoolInitializedInsert = {
            feeDenominator: EVM_POOL_FEE_DENOMINATOR,
            poolKey: {
              token0: parsed.poolKey.token0,
              token1: parsed.poolKey.token1,
              fee,
              tickSpacing,
              extension,
            },
            poolId: parsed.poolId,
            tick:
              typeof parsed.tick === "bigint"
                ? Number(parsed.tick)
                : parsed.tick,
            sqrtRatio: floatSqrtRatioToFixed(parsed.sqrtRatio),
          };
          const poolKeyId = await dao.insertPoolInitializedEvent(
            poolInitialized,
            key
          );

          if (BigInt(extension) === mevCaptureAddressBigInt) {
            await dao.insertMEVCapturePoolKey(poolKeyId);
          }
        },
        async PositionUpdated(dao, key, parsed) {
          await dao.insertPositionUpdatedEvent(parsed, key);
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
        await dao.insertTWAMMVirtualOrdersExecutedEvent(event, key);
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
              poolId: toPoolId({
                token0,
                token1,
                config: toPoolConfig({
                  fee: BigInt(parsed.orderKey.fee),
                  tickSpacing: 0,
                  extension: key.emitter,
                }),
              }),
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
              poolId: toPoolId({
                token0,
                token1,
                config: toPoolConfig({
                  fee: BigInt(parsed.orderKey.fee),
                  tickSpacing: 0,
                  extension: key.emitter,
                }),
              }),
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
