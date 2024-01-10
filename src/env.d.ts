declare namespace NodeJS {
  export interface ProcessEnv {
    LOG_LEVEL: string;

    CORE_ADDRESS: string;
    POSITIONS_ADDRESS: string;
    NFT_ADDRESS: string;
    TOKEN_REGISTRY_ADDRESS: string;
    TOKEN_REGISTRY_V2_ADDRESS: string;

    STARTING_CURSOR_BLOCK_NUMBER: string;

    APIBARA_AUTH_TOKEN: string;

    PG_CONNECTION_STRING: string;
  }
}
