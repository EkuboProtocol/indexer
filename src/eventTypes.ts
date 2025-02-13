import { CORE_V2_ABI, POSITIONS_ABI } from "./abis";
import type { ContractEvent } from "./logProcessors.ts";

export type PoolKey = ContractEvent<
  typeof CORE_V2_ABI,
  "PoolInitialized"
>["poolKey"];
export type CorePositionUpdated = ContractEvent<
  typeof CORE_V2_ABI,
  "PositionUpdated"
>;
export type CorePoolInitialized = ContractEvent<
  typeof CORE_V2_ABI,
  "PoolInitialized"
>;
export type CorePositionFeesCollected = ContractEvent<
  typeof CORE_V2_ABI,
  "PositionFeesCollected"
>;
export type CoreProtocolFeesWithdrawn = ContractEvent<
  typeof CORE_V2_ABI,
  "ProtocolFeesWithdrawn"
>;
export type CoreExtensionRegistered = ContractEvent<
  typeof CORE_V2_ABI,
  "ExtensionRegistered"
>;
export type CoreFeesAccumulated = ContractEvent<
  typeof CORE_V2_ABI,
  "FeesAccumulated"
>;

export type PositionTransfer = ContractEvent<typeof POSITIONS_ABI, "Transfer">;
