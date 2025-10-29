import { checksumAddress, numberToHex } from "viem";
import { toSigned } from "../swapEvent.ts";

export interface OracleEvent {
  token: `0x${string}`;
  timestamp: bigint;
  secondsPerLiquidityCumulative: bigint;
  tickCumulative: bigint;
}

export function parseOracleEvent(data: `0x${string}`): OracleEvent {
  let n = BigInt(data);

  // timestamp: uint32 (4 bytes)
  const timestamp = BigInt(n & ((1n << 32n) - 1n));
  n >>= 32n;

  // secondsPerLiquidityCumulative: uint160 (20 bytes)
  const secondsPerLiquidityCumulative = n & ((1n << 160n) - 1n);
  n >>= 160n;

  // tickCumulative: int64 (8 bytes)
  const tickCumulativeRaw = n & ((1n << 64n) - 1n);
  const tickCumulative = toSigned(tickCumulativeRaw, 64);
  n >>= 64n;

  // token: address (20 bytes)
  const tokenBigInt = n & ((1n << 160n) - 1n);
  const token = checksumAddress(numberToHex(tokenBigInt, { size: 20 }));

  return { token, timestamp, secondsPerLiquidityCumulative, tickCumulative };
}
