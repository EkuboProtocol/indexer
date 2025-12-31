import { checksumAddress, numberToHex } from "viem";

export function toSigned(value: bigint, bits: number): bigint {
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

const BIT_MASK = 0xc00000000000000000000000n;
const NOT_BIT_MASK = 0x3fffffffffffffffffffffffn;
export function floatSqrtRatioToFixed(sqrtRatioFloat: bigint): bigint {
  return (
    (sqrtRatioFloat & NOT_BIT_MASK) <<
    (2n + ((sqrtRatioFloat & BIT_MASK) >> 89n))
  );
}

const MAX_UINT32 = (1n << 32n) - 1n;
const MAX_UINT96 = (1n << 96n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

export function parseSwapEvent(data: `0x${string}`): CoreSwapped {
  let n = BigInt(data);

  // tick: int32 (4 bytes)
  const tickRaw = n & MAX_UINT32;
  const tickAfter = Number(toSigned(tickRaw, 32));
  n >>= 32n;

  // sqrtRatio: uint96 (12 bytes)
  const sqrtRatioAfterCompact = n & MAX_UINT96;
  n >>= 96n;

  const sqrtRatioAfter = floatSqrtRatioToFixed(sqrtRatioAfterCompact);

  // liquidity: uint128 (16 bytes)
  const liquidityAfter = n & MAX_UINT128;
  n >>= 128n;

  // delta1: int128 (16 bytes)
  const delta1Raw = n & MAX_UINT128;
  const delta1 = toSigned(delta1Raw, 128);
  n >>= 128n;

  // delta0: int128 (16 bytes)
  const delta0Raw = n & MAX_UINT128;
  const delta0 = toSigned(delta0Raw, 128);
  n >>= 128n;

  // poolId: bytes32 (32 bytes)
  const poolIdBigInt = n & MAX_UINT256;
  const poolId = numberToHex(poolIdBigInt, { size: 32 });
  n >>= 256n;

  // locker: address (20 bytes)
  const lockerBigInt = n & MAX_UINT160;
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

const LOG_DATA_LENGTH_V2 = 116; // bytes

function sliceHex(
  hex: string,
  startBytes: number,
  lengthBytes: number
): string {
  const start = startBytes * 2;
  return hex.slice(start, start + lengthBytes * 2);
}

export function parseSwapEventV3(data: `0x${string}`): CoreSwapped {
  if (!data.startsWith("0x")) {
    throw new Error("Swap event data must be hex-prefixed");
  }
  const hex = data.slice(2);

  if (hex.length !== LOG_DATA_LENGTH_V2 * 2) {
    throw new Error(
      `Unexpected swap event length: expected ${
        LOG_DATA_LENGTH_V2 * 2
      } hex chars, received ${hex.length}`
    );
  }

  const lockerChunk = sliceHex(hex, 0, 20).padStart(40, "0");
  const poolIdChunk = sliceHex(hex, 20, 32);
  const balanceUpdateChunk = sliceHex(hex, 52, 32);
  const stateAfterChunk = sliceHex(hex, 84, 32);

  const locker = checksumAddress(`0x${lockerChunk}` as `0x${string}`);
  const poolId = `0x${poolIdChunk}` as `0x${string}`;

  const balanceUpdate = BigInt(`0x${balanceUpdateChunk}`);
  const delta1Raw = balanceUpdate & MAX_UINT128;
  const delta0Raw = balanceUpdate >> 128n;
  const delta0 = toSigned(delta0Raw, 128);
  const delta1 = toSigned(delta1Raw, 128);

  const stateAfter = BigInt(`0x${stateAfterChunk}`);
  const liquidityAfter = stateAfter & MAX_UINT128;
  const tickRaw = (stateAfter >> 128n) & MAX_UINT32;
  const tickAfter = Number(toSigned(tickRaw, 32));
  const sqrtRatioAfterCompact = stateAfter >> 160n;
  const sqrtRatioAfter = floatSqrtRatioToFixed(sqrtRatioAfterCompact);

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
