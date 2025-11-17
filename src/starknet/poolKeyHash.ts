import type { PoolKey } from "./core.js";
import { createHash } from "crypto";

export function computeKeyHash(poolKey: PoolKey): bigint {
  return BigInt(
    `0x${createHash("sha256")
      .update(poolKey.token0.toString(16).padStart(64, "0"), "hex")
      .update(poolKey.token1.toString(16).padStart(64, "0"), "hex")
      .update(poolKey.fee.toString(16).padStart(32, "0"), "hex")
      .update(poolKey.tick_spacing.toString(16).padStart(32, "0"), "hex")
      .update(poolKey.extension.toString(16).padStart(64, "0"), "hex")
      .digest("hex")}`
  );
}
