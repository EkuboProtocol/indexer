import { numberToHex } from "viem";

export interface TwammVirtualOrdersExecutedEvent {
  poolId: `0x${string}`;
  saleRateToken0: bigint;
  saleRateToken1: bigint;
}

const MAX_UINT112 = (1n << 112n) - 1n;

export function parseTwammVirtualOrdersExecuted(
  data: `0x${string}`,
): TwammVirtualOrdersExecutedEvent {
  let n = BigInt(data);

  // tickCumulative: int64 (8 bytes)
  const saleRateToken1 = n & MAX_UINT112;
  n >>= 112n;
  const saleRateToken0 = n & MAX_UINT112;
  n >>= 112n;
  const poolId = numberToHex(n, { size: 32 });

  return { poolId, saleRateToken0, saleRateToken1 };
}
