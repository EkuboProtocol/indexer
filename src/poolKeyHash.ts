import { createHash } from "crypto";
import type { PoolKey } from "./eventTypes.ts";

export function computeKeyHash(coreAddress: bigint, poolKey: PoolKey): bigint {
  return BigInt(
    `0x${createHash("sha256")
      .update(coreAddress.toString(16).padStart(40, "0"), "hex")
      .update(BigInt(poolKey.token0).toString(16).padStart(64, "0"), "hex")
      .update(BigInt(poolKey.token1).toString(16).padStart(64, "0"), "hex")
      .update(poolKey.fee.toString(16).padStart(32, "0"), "hex")
      .update(poolKey.tickSpacing.toString(16).padStart(32, "0"), "hex")
      .update(BigInt(poolKey.extension).toString(16).padStart(64, "0"), "hex")
      .digest("hex")}`,
  );
}
