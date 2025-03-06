import {
  checksumAddress,
  encodeAbiParameters,
  keccak256,
  numberToHex,
} from "viem";

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
