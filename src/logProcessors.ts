import { DAO } from "./dao.ts";
import type { EventKey } from "./processor.ts";
import { CORE_ABI, ORACLE_ABI, POSITIONS_ABI } from "./abis.ts";
import type {
  Abi,
  AbiParameterToPrimitiveType,
  ExtractAbiEvent,
  ExtractAbiEventNames,
} from "abitype";
import { decodeEventLog, encodeEventTopics } from "viem";
import { logger } from "./logger.ts";

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
  const T extends Abi,
  N extends ExtractAbiEventNames<T>,
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
      const result = decodeEventLog({
        abi,
        eventName: eventName as any,
        topics: event.topics as any,
        data: event.data,
      });

      logger.debug(`Processing ${eventName}`, { event: result.args });
      await wrappedHandler(dao, key, result.args as any);
    },
  };
}

type HandlerMap<T extends Abi> = {
  [eventName in ExtractAbiEventNames<T>]?: Parameters<
    typeof createContractEventProcessor<T, eventName>
  >[0]["handler"];
};

type ContractHandlers<T extends Abi> = {
  address: `0x${string}`;
  abi: T;
  handlers: HandlerMap<T>;
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
} = {
  Core: {
    address: process.env.CORE_ADDRESS,
    abi: CORE_ABI,
    handlers: {
      async PoolInitialized(dao, key, parsed) {
        await dao.insertPoolInitializedEvent(parsed, key);
      },
      async PositionUpdated(dao, key, parsed) {
        await dao.insertPositionUpdatedEvent(parsed, key);
      },
      async PositionFeesCollected(dao, key, parsed) {
        await dao.insertPositionFeesCollectedEvent(parsed, key);
      },
      async Swapped(dao, key, parsed) {
        await dao.insertSwappedEvent(parsed, key);
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
    handlers: {
      async SnapshotEvent(dao, key, parsed) {
        await dao.insertOracleSnapshotEvent(parsed, key);
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
      Object.entries(handlers).map(
        ([eventName, handler]): LogProcessor =>
          createContractEventProcessor({
            address,
            abi,
            eventName: eventName as ExtractAbiEventNames<typeof abi>,
            handler,
          }),
      ),
    ),
) as LogProcessor[];
