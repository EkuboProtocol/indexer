import { DAO } from "./dao.ts";
import type { EventKey } from "./processor.ts";
import { CORE_ABI, ORACLE_ABI, POSITIONS_ABI, TWAMM_ABI } from "./abis.ts";
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
import { logger } from "./logger.ts";
import { floatSqrtRatioToFixed, parseSwapEvent } from "./swapEvent.ts";
import { parseOracleEvent } from "./oracleEvent.ts";
import { parseTwammEvent } from "./twammEvent.ts";

export type ContractEvent<
  abi extends Abi,
  N extends ExtractAbiEventNames<abi>,
> = {
  [P in ExtractAbiEvent<abi, N>["inputs"][number] as P extends {
    name: infer N extends string;
  }
    ? N
    : never]: AbiParameterToPrimitiveType<P>;
};

interface LogProcessor {
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
    },
  ) => Promise<void>;
}

export function createContractEventProcessor<
  T extends Abi,
  N extends ContractEventName<T>,
>({
  address,
  abi,
  eventName,
  handler: wrappedHandler,
}: {
  address: `0x${string}`;
  abi: T;
  eventName: N;
  handler(dao: DAO, key: EventKey, event: ContractEvent<T, N>): Promise<void>;
}): LogProcessor {
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

      logger.debug(`Processing ${eventName}`, { key, event: result.args });
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
    data: `0x${string}` | undefined,
  ) => Promise<void>;
};

const processors: {
  Core: ContractHandlers<typeof CORE_ABI>;
  Positions: ContractHandlers<typeof POSITIONS_ABI>;
  Oracle: ContractHandlers<typeof ORACLE_ABI>;
  TWAMM: ContractHandlers<typeof TWAMM_ABI>;
} = {
  Core: {
    address: process.env.CORE_ADDRESS,
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
        await dao.insertPoolInitializedEvent(
          {
            ...parsed,
            sqrtRatio: floatSqrtRatioToFixed(parsed.sqrtRatio),
          },
          key,
        );
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
    address: process.env.POSITIONS_ADDRESS,
    abi: POSITIONS_ABI,
    handlers: {
      async Transfer(dao, key, parsed) {
        await dao.insertPositionTransferEvent(parsed, key);
      },
    },
  },
  Oracle: {
    address: process.env.ORACLE_ADDRESS,
    abi: ORACLE_ABI,
    async noTopics(dao, key, data) {
      if (!data) throw new Error("Event with no data from Oracle");
      const event = parseOracleEvent(data);
      logger.debug(`Parsed Oracle Event`, {
        event,
        rawData: data,
      });
      await dao.insertOracleSnapshotEvent(event, key);
    },
  },
  TWAMM: {
    address: process.env.TWAMM_ADDRESS,
    abi: TWAMM_ABI,
    async noTopics(dao, key, data) {
      if (!data) throw new Error("Event with no data from TWAMM");
      const event = parseTwammEvent(data);
      logger.debug(`Parsed TWAMM Event`, {
        event,
        rawData: data,
      });
      // await dao.insertVirtualOrdersExecutedEvent(event, key);
    },
    handlers: {
      async OrderUpdated(dao, key, parsed) {
        // await dao.insertTwammOrderUpdatedEvent(event, key);
      },
      async OrderProceedsWithdrawn(dao, key, parsed) {
        // await dao.insertTwammOrderProceedsWithdrawnEvent(event, key);
      },
    },
  },
};

export const LOG_PROCESSORS = Object.values(processors).flatMap(
  ({ address, abi, handlers, noTopics }) =>
    (noTopics
      ? [
          <LogProcessor>{
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
            ([eventName, handler]): LogProcessor =>
              createContractEventProcessor({
                address,
                abi,
                eventName: eventName as ExtractAbiEventNames<typeof abi>,
                handler: handler as any,
              }),
          )
        : [],
    ),
) as LogProcessor[];
