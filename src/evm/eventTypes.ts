import {
  CORE_ABI,
  INCENTIVES_ABI,
  ORDERS_ABI,
  POSITIONS_ABI,
  TOKEN_WRAPPER_FACTORY_ABI,
  TWAMM_ABI,
} from "./abis.ts";
import type { ContractEvent } from "./logProcessors.ts";

export type PoolKey = ContractEvent<
  typeof CORE_ABI,
  "PoolInitialized"
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
export type CoreProtocolFeesWithdrawn = ContractEvent<
  typeof CORE_ABI,
  "ProtocolFeesWithdrawn"
>;
export type CoreExtensionRegistered = ContractEvent<
  typeof CORE_ABI,
  "ExtensionRegistered"
>;
export type CoreFeesAccumulated = ContractEvent<
  typeof CORE_ABI,
  "FeesAccumulated"
>;

export type PositionTransfer = ContractEvent<typeof POSITIONS_ABI, "Transfer">;
export type OrderTransfer = ContractEvent<typeof ORDERS_ABI, "Transfer">;

export type TwammOrderUpdated = ContractEvent<typeof TWAMM_ABI, "OrderUpdated">;
export type TwammOrderProceedsWithdrawn = ContractEvent<
  typeof TWAMM_ABI,
  "OrderProceedsWithdrawn"
>;

export type IncentivesFunded = ContractEvent<typeof INCENTIVES_ABI, "Funded">;
export type IncentivesRefunded = ContractEvent<
  typeof INCENTIVES_ABI,
  "Refunded"
>;

export type TokenWrapperDeployed = ContractEvent<
  typeof TOKEN_WRAPPER_FACTORY_ABI,
  "TokenWrapperDeployed"
>;
