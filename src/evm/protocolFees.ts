export const EVM_POOL_FEE_DENOMINATOR = 1n << 64n;

export function divFloor(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  if (remainder === 0n) return quotient;

  const hasDifferentSigns =
    (remainder > 0n && denominator < 0n) ||
    (remainder < 0n && denominator > 0n);

  return hasDifferentSigns ? quotient - 1n : quotient;
}

export function calculateSwapProtocolFeeDelta(
  amount: bigint,
  swapProtocolFee: bigint,
  feeDenominator: bigint = EVM_POOL_FEE_DENOMINATOR
): bigint {
  if (swapProtocolFee <= 0n || swapProtocolFee >= feeDenominator) return 0n;

  // note we round up
  return -((amount * swapProtocolFee + feeDenominator - 1n) / feeDenominator);
}

export function calculateWithdrawalProtocolFeeDelta(
  delta: bigint,
  protocolFee: bigint,
  feeDenominator: bigint = EVM_POOL_FEE_DENOMINATOR
): bigint {
  if (delta >= 0n || protocolFee <= 0n || protocolFee >= feeDenominator)
    return 0n;

  const adjustedDenominator = feeDenominator - protocolFee;
  return divFloor(delta * feeDenominator, adjustedDenominator) - delta;
}
