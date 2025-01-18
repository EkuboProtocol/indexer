declare namespace NodeJS {
  export interface ProcessEnv {
    LOG_LEVEL: string;

    CORE_ADDRESS: `0x${string}`;
    POSITIONS_ADDRESS: `0x${string}`;
    ORACLE_ADDRESS: `0x${string}`;
    ORACLE_TOKEN: `0x${string}`;

    STARTING_CURSOR_BLOCK_NUMBER: string;

    APIBARA_AUTH_TOKEN: string;

    PG_CONNECTION_STRING: string;
  }
}
