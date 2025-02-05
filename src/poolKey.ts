import type { PoolKey } from "./eventTypes.ts";
import { encodeAbiParameters, keccak256 } from "viem";

/**
 * This exactly matches the pool ID that is used in the mappings in core
 * @param poolKey the pool key that is encoded and then hashed
 */
export function toPoolId(poolKey: PoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "token0", type: "address" },
        { name: "token1", type: "address" },
        { name: "fee", type: "uint128" },
        { name: "tickSpacing", type: "uint32" },
        { name: "extension", type: "address" },
      ],
      [
        poolKey.token0,
        poolKey.token1,
        poolKey.fee,
        poolKey.tickSpacing,
        poolKey.extension,
      ],
    ),
  );
}
