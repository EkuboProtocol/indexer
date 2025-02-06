import { checksumAddress, numberToHex } from "viem";

function toSigned(value: bigint, bits: number): bigint {
  const half = 1n << BigInt(bits - 1);
  return value >= half ? value - (1n << BigInt(bits)) : value;
}

export interface CoreSwapped {
  locker: `0x${string}`;
  poolId: `0x${string}`;
  delta0: bigint;
  delta1: bigint;
  liquidityAfter: bigint;
  sqrtRatioAfter: bigint;
  tickAfter: number;
}

export function parseV2SwapEventData(data: `0x${string}`): CoreSwapped {
  let n = BigInt(data);

  // tick: int32 (4 bytes)
  const tickRaw = n & ((1n << 32n) - 1n);
  const tickAfter = Number(toSigned(tickRaw, 32));
  n >>= 32n;

  // sqrtRatio: uint192 (24 bytes)
  const sqrtRatioAfter = n & ((1n << 192n) - 1n);
  // todo: this should be 192
  n >>= 160n;

  // liquidity: uint128 (16 bytes)
  const liquidityAfter = n & ((1n << 128n) - 1n);
  n >>= 128n;

  // delta1: int128 (16 bytes)
  const delta1Raw = n & ((1n << 128n) - 1n);
  const delta1 = toSigned(delta1Raw, 128);
  n >>= 128n;

  // delta0: int128 (16 bytes)
  const delta0Raw = n & ((1n << 128n) - 1n);
  const delta0 = toSigned(delta0Raw, 128);
  n >>= 128n;

  // poolId: bytes32 (32 bytes)
  const poolIdBigInt = n & ((1n << 256n) - 1n);
  const poolId = numberToHex(poolIdBigInt, { size: 32 });
  n >>= 256n;

  // locker: address (20 bytes)
  const lockerBigInt = n & ((1n << 160n) - 1n);
  const locker = checksumAddress(numberToHex(lockerBigInt, { size: 20 }));

  return {
    locker,
    poolId,
    delta0,
    delta1,
    liquidityAfter,
    sqrtRatioAfter,
    tickAfter,
  };
}
