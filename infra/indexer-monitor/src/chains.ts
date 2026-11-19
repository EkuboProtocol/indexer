import type { Expected } from "./status";

/**
 * The chains the monitor must report on: the 15 production indexer workers.
 * Head-lag names are those of `HEAD_LAG_CHAINS`; event-gap names are the
 * `GAP_MONITOR_CHAINS` labels (`starknet/` marks Starknet). A chain the report
 * leaves out shows up as missing telemetry, so a configuration that drops a
 * chain cannot pass silently. Change this list with `.do/app.yaml`.
 */
export const EXPECTED: Expected = {
  headChains: [
    "eth",
    "optimism",
    "bsc",
    "gnosis",
    "unichain",
    "polygon",
    "monad",
    "worldchain",
    "megaeth",
    "rhc",
    "base",
    "arbitrum",
    "ink",
    "elysium",
    "starknet",
  ],
  gapChains: [
    "mainnet",
    "base-mainnet",
    "arb-mainnet",
    "opt-mainnet",
    "polygon-mainnet",
    "gnosis-mainnet",
    "unichain-mainnet",
    "worldchain-mainnet",
    "ink-mainnet",
    "megaeth",
    "rhc-mainnet",
    "monad",
    "bsc-mainnet",
    "starknet/mainnet",
    "elysium-mainnet",
  ],
};

/** The canary's isolated state expects one chain of each kind. */
export const CANARY_EXPECTED: Expected = {
  headChains: ["canary"],
  gapChains: ["canary"],
};
