import {
  checksumAddress,
  encodeAbiParameters,
  keccak256,
  numberToHex,
} from "viem";
import { toSigned } from "./swapEvent";

export interface EncodedPoolKey {
  token0: `0x${string}`;
  token1: `0x${string}`;
  config: `0x${string}`;
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

export function parseV2PoolKeyConfig(_config: `0x${string}`):
  | {
      fee: bigint;
      tickSpacing: number;
      extension: `0x${string}`;
    }
  | {
      fee: bigint;
      centerTick: number;
      amplificationFactor: number;
      extension: `0x${string}`;
    } {
  const config = BigInt(_config);
  const extension = checksumAddress(numberToHex(config >> 96n, { size: 20 }));
  const fee = (config >> 32n) & ((1n << 64n) - 1n);
  const typeConfig = config & 0xffffffffn;
  const isConcentrated = (typeConfig & 0x80000000n) !== 0n;

  if (isConcentrated) {
    const tickSpacing = Number(typeConfig & 0x7fffffffn);
    return {
      fee,
      tickSpacing,
      extension,
    };
  }

  const amplificationFactor = Number((typeConfig >> 24n) & 0x7fn);
  let centerTick24 = Number(typeConfig & 0xffffffn);
  if ((centerTick24 & 0x800000) !== 0) {
    centerTick24 -= 0x1000000;
  }
  const centerTick = centerTick24 * 16;

  return {
    fee,
    centerTick,
    amplificationFactor,
    extension,
  };
}

export function parsePoolBalanceUpdate(_balanceUpdate: `0x${string}`): {
  delta0: bigint;
  delta1: bigint;
} {
  const update = BigInt(_balanceUpdate);
  const delta1Raw = update & ((1n << 128n) - 1n);
  const delta0Raw = update >> 128n;
  return {
    delta0: toSigned(delta0Raw, 128),
    delta1: toSigned(delta1Raw, 128),
  };
}
export function parsePositionId(_positionId: `0x${string}`): {
  salt: bigint;
  lower: number;
  upper: number;
} {
  const positionId = BigInt(_positionId);
  const upper = Number(toSigned(positionId & 0xffffffffn, 32));
  const lower = Number(toSigned((positionId >> 32n) & 0xffffffffn, 32));
  const salt = positionId >> 64n;

  return { salt, lower, upper };
}

export function parseOrderConfig(_config: `0x${string}`): {
  isToken1: boolean;
  salt: bigint;
  fee: bigint;
  startTime: bigint;
  endTime: bigint;
} {
  const config = BigInt(_config);
  const endTime = config & ((1n << 64n) - 1n);
  const startTime = (config >> 64n) & ((1n << 64n) - 1n);
  const salt = (config >> 128n) & ((1n << 56n) - 1n);
  const isToken1 = ((config >> 184n) & 0xffn) !== 0n;
  const fee = (config >> 192n) & ((1n << 64n) - 1n);

  return {
    isToken1,
    salt,
    fee,
    startTime,
    endTime,
  };
}

const MAX_FEE: bigint = 2n ** 64n - 1n;

export function toPoolConfigV1({
  fee,
  tickSpacing,
  extension,
}: {
  fee: bigint;
  tickSpacing: number;
  extension: `0x${string}`;
}): `0x${string}` {
  if (fee > MAX_FEE) throw new Error("Invalid fee");
  return numberToHex(
    BigInt(tickSpacing) + (fee << 32n) + (BigInt(extension) << 96n),
    { size: 32 }
  );
}

/**
 * This exactly matches the pool ID that is used in the mappings in core
 * @param poolKey the pool key that is encoded and then hashed
 */
export function toPoolId(poolKey: EncodedPoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "token0", type: "address" },
        { name: "token1", type: "address" },
        { name: "config", type: "bytes32" },
      ],
      [poolKey.token0, poolKey.token1, poolKey.config]
    )
  );
}
