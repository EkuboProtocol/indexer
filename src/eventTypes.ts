import type {
  ExtractAbiEvent,
  ExtractAbiEventNames,
  AbiParameterToPrimitiveType,
  Abi,
} from "abitype";
import { CORE_ABI, ORACLE_ABI, POSITIONS_ABI } from "./abis";

type ContractEvent<abi extends Abi, N extends ExtractAbiEventNames<abi>> = {
  [P in ExtractAbiEvent<abi, N>["inputs"][number] as P extends {
    name: infer N extends string;
  }
    ? N
    : never]: AbiParameterToPrimitiveType<P>;
};

export type PoolKey = ContractEvent<
  typeof CORE_ABI,
  "PositionUpdated"
>["poolKey"];
export type CorePositionUpdated = ContractEvent<
  typeof CORE_ABI,
  "PositionUpdated"
>;
export type CorePoolInitialized = ContractEvent<
  typeof CORE_ABI,
  "PoolInitialized"
>;
export type CorePositionFeesCollected = ContractEvent<
  typeof CORE_ABI,
  "PositionFeesCollected"
>;
export type CoreProtocolFeesPaid = ContractEvent<
  typeof CORE_ABI,
  "ProtocolFeesPaid"
>;
export type CoreProtocolFeesWithdrawn = ContractEvent<
  typeof CORE_ABI,
  "ProtocolFeesWithdrawn"
>;
export type CoreFeesAccumulated = ContractEvent<
  typeof CORE_ABI,
  "FeesAccumulated"
>;
export type CoreSwapped = ContractEvent<typeof CORE_ABI, "Swapped">;
export type PositionTransfer = ContractEvent<typeof POSITIONS_ABI, "Transfer">;
export type SnapshotEvent = ContractEvent<typeof ORACLE_ABI, "SnapshotEvent">;
