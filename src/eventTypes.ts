import type {
  ExtractAbiEvent,
  ExtractAbiEventNames,
  AbiParameterToPrimitiveType,
} from "abitype";
import { CORE_ABI, ORACLE_ABI, POSITIONS_ABI } from "./abis";

type CoreEventNames = ExtractAbiEventNames<typeof CORE_ABI>;

type CoreContractEvent<N extends CoreEventNames> = {
  [P in ExtractAbiEvent<typeof CORE_ABI, N>["inputs"][number] as P extends {
    name: infer N extends string;
  }
    ? N
    : never]: AbiParameterToPrimitiveType<P>;
};

type PositionEventNames = ExtractAbiEventNames<typeof POSITIONS_ABI>;

type PositionContractEvent<N extends PositionEventNames> = {
  [P in ExtractAbiEvent<
    typeof POSITIONS_ABI,
    N
  >["inputs"][number] as P extends {
    name: infer N extends string;
  }
    ? N
    : never]: AbiParameterToPrimitiveType<P>;
};

type OracleEventNames = ExtractAbiEventNames<typeof ORACLE_ABI>;

type OracleContractEvent<N extends OracleEventNames> = {
  [P in ExtractAbiEvent<typeof ORACLE_ABI, N>["inputs"][number] as P extends {
    name: infer N extends string;
  }
    ? N
    : never]: AbiParameterToPrimitiveType<P>;
};

export type PoolKey = CoreContractEvent<"PositionUpdated">["poolKey"];
export type CorePositionUpdated = CoreContractEvent<"PositionUpdated">;
export type CorePoolInitialized = CoreContractEvent<"PoolInitialized">;
export type CorePositionFeesCollected =
  CoreContractEvent<"PositionFeesCollected">;
export type CoreProtocolFeesPaid = CoreContractEvent<"ProtocolFeesPaid">;
export type CoreProtocolFeesWithdrawn =
  CoreContractEvent<"ProtocolFeesWithdrawn">;
export type CoreFeesAccumulated = CoreContractEvent<"FeesAccumulated">;
export type CoreSwapped = CoreContractEvent<"Swapped">;
// export type CoreLoadedBalance = CoreContractEvent<"LoadedBalance">;
export type PositionTransfer = PositionContractEvent<"Transfer">;
export type SnapshotEvent = OracleContractEvent<"SnapshotEvent">;
