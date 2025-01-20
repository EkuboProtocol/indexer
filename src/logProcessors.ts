import { DAO } from "./dao.ts";
import type { EventKey } from "./processor.ts";
import { CORE_ABI, ORACLE_ABI, POSITIONS_ABI } from "./abis.ts";
import type {
  Abi,
  AbiParameterToPrimitiveType,
  ExtractAbiEvent,
  ExtractAbiEventNames,
} from "abitype";

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

interface LogProcessor<T extends Abi, N extends ExtractAbiEventNames<T>> {
  address: `0x${string}`;

  abi: T;
  eventName: N;

  handler: (
    dao: DAO,
    key: EventKey,
    event: ContractEvent<T, N>,
  ) => Promise<void>;
}

type HandlerMap<T extends Abi> = {
  [eventName in ExtractAbiEventNames<T>]?: LogProcessor<
    T,
    eventName
  >["handler"];
};

type ContractHandlers<T extends Abi> = {
  address: string;
  abi: T;
  handlers: HandlerMap<T>;
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
      async ProtocolFeesPaid(dao, key, parsed) {
        await dao.insertProtocolFeesPaid(parsed, key);
      },
      async ProtocolFeesWithdrawn(dao, key, parsed) {
        await dao.insertProtocolFeesWithdrawn(parsed, key);
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
  ({ address, abi, handlers }) =>
    Object.entries(handlers).map(([eventName, handler]) => ({
      address,
      abi,
      eventName,
      handler,
    })),
) as LogProcessor<any, any>[];
