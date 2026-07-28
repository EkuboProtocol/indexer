import type { PriceUpdate } from "./types";

export function toHexTokenAddress(address: string): `0x${string}` {
  return `0x${BigInt(address).toString(16)}`;
}

export function toPriceUpdates(
  chainId: bigint,
  prices: Iterable<readonly [tokenAddress: string, usdPrice: number]>,
  timestamp = new Date(),
): PriceUpdate[] {
  return Array.from(prices, ([tokenAddress, usdPrice]) => ({
    chainId,
    tokenAddress: toHexTokenAddress(tokenAddress),
    timestamp,
    usdPrice,
  }));
}
