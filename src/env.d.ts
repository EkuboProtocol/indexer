interface CommonConfiguration {
  LOG_LEVEL: string;

  NETWORK: string;
  CHAIN_ID: string;

  STARTING_CURSOR_BLOCK_NUMBER: string;

  DNA_TOKEN: string;
  APIBARA_URL: string;
  PG_CONNECTION_STRING: string;

  NO_BLOCKS_TIMEOUT_MS: string; // Time in milliseconds before exiting if no blocks are received
  EVENT_STATS_BLOCK_INTERVAL?: string; // Number of blocks between ingestion stats logs (default 100)
  TOKEN_PRICE_SYNC_INTERVAL_MS?: string; // Interval for the token price worker (milliseconds)
}

interface EvmConfig extends CommonConfiguration {
  NETWORK_TYPE: "evm";

  CORE_ADDRESS: `0x${string}`;
  POSITIONS_ADDRESS: `0x${string}`;
  ORACLE_ADDRESS: `0x${string}`;
  TWAMM_ADDRESS: `0x${string}`;
  ORDERS_ADDRESS: `0x${string}`;
  INCENTIVES_ADDRESS: `0x${string}`;
  MEV_CAPTURE_ADDRESS: `0x${string}`;
  TOKEN_WRAPPER_FACTORY_ADDRESS: `0x${string}`;

  CORE_V2_ADDRESS: `0x${string}`;
  POSITIONS_V2_ADDRESS: `0x${string}`;
  ORACLE_V2_ADDRESS: `0x${string}`;
  TWAMM_V2_ADDRESS: `0x${string}`;
  ORDERS_V2_ADDRESS: `0x${string}`;
  INCENTIVES_V2_ADDRESS: `0x${string}`;
  MEV_CAPTURE_V2_ADDRESS: `0x${string}`;
  TOKEN_WRAPPER_FACTORY_V2_ADDRESS: `0x${string}`;
}

interface StarknetConfig extends CommonConfiguration {
  NETWORK_TYPE: "starknet";

  CORE_ADDRESS: `0x${string}`;
  NFT_ADDRESS: `0x${string}`;
  TWAMM_ADDRESS: `0x${string}`;
  STAKER_ADDRESS: `0x${string}`;
  GOVERNOR_ADDRESS: `0x${string}`;
  ORACLE_ADDRESS: `0x${string}`;
  LIMIT_ORDERS_ADDRESS: `0x${string}`;
  SPLINE_LIQUIDITY_PROVIDER_ADDRESS: `0x${string}`;

  TOKEN_REGISTRY_ADDRESS: `0x${string}`;
  TOKEN_REGISTRY_V2_ADDRESS: `0x${string}`;
  TOKEN_REGISTRY_V3_ADDRESS: `0x${string}`;
}

declare namespace NodeJS {
  export type ProcessEnv = EvmConfig | StarknetConfig;
}
