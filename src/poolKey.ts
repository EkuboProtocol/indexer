import type { PoolKey, PoolKeyV1 } from "./eventTypes.ts";
import {
  checksumAddress,
  encodeAbiParameters,
  keccak256,
  numberToHex,
} from "viem";

export function toPoolConfig(
  fee: bigint,
  tickSpacing: number,
  extension: `0x${string}`,
): `0x${string}` {
  return numberToHex(
    BigInt(tickSpacing) + (fee << 32n) + (BigInt(extension) << 96n),
    { size: 32 },
  );
}

export function parsePoolKeyConfig(config: `0x${string}`): {
  fee: bigint;
  tickSpacing: number;
  extension: `0x${string}`;
} {
  const c = BigInt(config);
  return {
    tickSpacing: Number(c % 2n ** 32n),
    fee: (c >> 32n) % 2n ** 64n,
    extension: checksumAddress(numberToHex(c >> 96n, { size: 20 })),
  };
}

export function toV2PoolKey(poolKey: PoolKeyV1): PoolKey {
  return {
    token0: poolKey.token0,
    token1: poolKey.token1,
    config: toPoolConfig(poolKey.fee, poolKey.tickSpacing, poolKey.extension),
  };
}

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
        { name: "config", type: "bytes32" },
      ],
      [poolKey.token0, poolKey.token1, poolKey.config],
    ),
  );
}

export function toKeyHash(
  coreAddress: `0x${string}`,
  poolId: `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "coreAddress", type: "address" },
        { name: "poolId", type: "bytes32" },
      ],
      [coreAddress, poolId],
    ),
  );
}
