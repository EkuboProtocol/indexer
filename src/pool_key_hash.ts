import { createHash } from "crypto";
import type { ExtractAbiEvent, ExtractAbiEventNames } from "abitype";
import type { CORE_ABI } from "./abis.ts";
import type { AbiEventParameterToPrimitiveType } from "viem";

const KEY_HASH_CACHE: { [key: string]: bigint } = {};

type CoreEvent<N extends ExtractAbiEventNames<typeof CORE_ABI>> = {
  [P in ExtractAbiEvent<typeof CORE_ABI, N>["inputs"][number] as P extends {
    name: infer N extends string;
  }
    ? N
    : never]: AbiEventParameterToPrimitiveType<P>;
};

export type PoolKey = CoreEvent<"PoolInitialized">["poolKey"];

function computeCacheKey(poolKey: PoolKey): string {
  return `${poolKey.token0}-${poolKey.token1}-${poolKey.fee}-${poolKey.tick_spacing}-${poolKey.extension}`;
}

export function populateCache(
  values: { pool_key: PoolKey; hash: bigint }[],
): void {
  values.forEach(
    ({ pool_key, hash }) => (KEY_HASH_CACHE[computeCacheKey(pool_key)] = hash),
  );
}

// instead uses the node crypto api: https://nodejs.org/api/crypto.html#hashdigestencoding
export function computeKeyHash(poolKey: PoolKey): bigint {
  const cacheKey = computeCacheKey(poolKey);
  return (
    KEY_HASH_CACHE[cacheKey] ??
    (KEY_HASH_CACHE[cacheKey] = BigInt(
      `0x${createHash("sha256")
        .update(poolKey.token0.toString(16).padStart(64, "0"), "hex")
        .update(poolKey.token1.toString(16).padStart(64, "0"), "hex")
        .update(poolKey.fee.toString(16).padStart(32, "0"), "hex")
        .update(poolKey.tick_spacing.toString(16).padStart(32, "0"), "hex")
        .update(poolKey.extension.toString(16).padStart(64, "0"), "hex")
        .digest("hex")}`,
    ))
  );
}
