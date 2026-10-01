import { config } from "dotenv";
import type { NetworkType } from "./types";

/** The variable each worker reads its RPC endpoint from. */
export const RPC_URL_VARIABLES: Record<NetworkType, string> = {
  evm: "EVM_RPC_URL",
  starknet: "STARKNET_RPC_URL",
};

/**
 * The image sets `NODE_ENV=production` and `.do/app.yaml` overrides it with
 * `PRODUCTION`, so the comparison ignores case.
 */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV?.toLowerCase() === "production";
}

/**
 * In production, a worker's RPC URL must come from its own environment. The
 * image ships every `.env.evm.*` file, each with a key-free public
 * `EVM_RPC_URL` meant for local runs, and dotenv fills in whatever the
 * environment lacks. A worker whose spec entry lost the key would otherwise
 * index from a rate-limited public endpoint without an error. Call this before
 * `loadConfig`, which is what would fill the gap.
 */
export function requireDeployedRpcUrl(
  networkType: NetworkType,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isProduction(env)) return;
  const name = RPC_URL_VARIABLES[networkType];
  if (!env[name]?.trim()) {
    throw new Error(
      `Missing ${name}: in production it must be set in the worker's environment, not taken from a committed .env file`,
    );
  }
}

export function loadConfig(networkType?: NetworkType) {
  if (networkType) {
    config({
      path: `./.env.${networkType}.${process.env.NETWORK}.local`,
    });
    config({ path: `./.env.${networkType}.${process.env.NETWORK}` });
    config({ path: `./.env.${networkType}.local` });
    config({ path: `./.env.${networkType}` });
  }
  config({ path: `./.env.local` });
  config({ path: `./.env` });
}
