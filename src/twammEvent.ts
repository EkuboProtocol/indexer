import { numberToHex } from "viem";

export interface TwammEvent {
  poolId: `0x${string}`;
  saleRateToken0: bigint;
  saleRateToken1: bigint;
}

export function parseTwammEvent(data: `0x${string}`): TwammEvent {
  let n = BigInt(data);

  // tickCumulative: int64 (8 bytes)
  const saleRateToken1 = n & ((1n << 112n) - 1n);
  n >>= 112n;
  const saleRateToken0 = n & ((1n << 112n) - 1n);
  n >>= 112n;
  const poolId = numberToHex(n, { size: 32 });

  return { poolId, saleRateToken0, saleRateToken1 };
}
