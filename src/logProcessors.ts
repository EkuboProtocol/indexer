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

const POSITIONS_ADDRESS = process.env.POSITIONS_ADDRESS;
const CORE_ADDRESS = process.env.CORE_ADDRESS;

export const LOG_PROCESSORS = [
  <LogProcessor<typeof POSITIONS_ABI, "Transfer">>{
    address: POSITIONS_ADDRESS,
    abi: POSITIONS_ABI,
    eventName: "Transfer",
    async handler(dao, key, parsed) {
      await dao.insertPositionTransferEvent(parsed, key);
    },
  },
  <LogProcessor<typeof CORE_ABI, "PoolInitialized">>{
    address: CORE_ADDRESS,
    abi: CORE_ABI,
    eventName: "PoolInitialized",
    async handler(dao, key, parsed) {
      await dao.insertPoolInitializedEvent(parsed, key);
    },
  },
  <LogProcessor<typeof CORE_ABI, "PositionUpdated">>{
    address: CORE_ADDRESS,
    abi: CORE_ABI,
    eventName: "PositionUpdated",
    async handler(dao, key, parsed) {
      await dao.insertPositionUpdatedEvent(parsed, key);
    },
  },
  <LogProcessor<typeof CORE_ABI, "PositionFeesCollected">>{
    address: CORE_ADDRESS,
    abi: CORE_ABI,
    eventName: "PositionFeesCollected",
    async handler(dao, key, parsed) {
      await dao.insertPositionFeesCollectedEvent(parsed, key);
    },
  },
  <LogProcessor<typeof CORE_ABI, "Swapped">>{
    address: CORE_ADDRESS,
    abi: CORE_ABI,
    eventName: "Swapped",
    async handler(dao, key, parsed) {
      await dao.insertSwappedEvent(parsed, key);
    },
  },
  <LogProcessor<typeof CORE_ABI, "ProtocolFeesWithdrawn">>{
    address: CORE_ADDRESS,
    abi: CORE_ABI,
    eventName: "ProtocolFeesWithdrawn",
    async handler(dao, key, parsed) {
      await dao.insertProtocolFeesWithdrawn(parsed, key);
    },
  },
  <LogProcessor<typeof CORE_ABI, "ProtocolFeesPaid">>{
    address: CORE_ADDRESS,
    abi: CORE_ABI,
    eventName: "ProtocolFeesPaid",
    async handler(dao, key, parsed) {
      await dao.insertProtocolFeesPaid(parsed, key);
    },
  },
  <LogProcessor<typeof ORACLE_ABI, "SnapshotEvent">>{
    address: CORE_ADDRESS,
    abi: ORACLE_ABI,
    eventName: "SnapshotEvent",
    async handler(dao, key, parsed) {
      await dao.insertOracleSnapshotEvent(parsed, key);
    },
  },
] as const;
