export const EVM_POOL_FEE_DENOMINATOR = 1n << 64n;

// computes the fee for a given amount, rounding up. assumes amount >= 0.
export function computeFee(
  amount: bigint,
  fee: bigint,
  feeDenominator: bigint = EVM_POOL_FEE_DENOMINATOR
): bigint {
  if (fee >= feeDenominator) throw new Error("fee == feeDenominator");

  return (amount * fee + feeDenominator - 1n) / feeDenominator;
}

export function calculateWithdrawalProtocolFeeDelta(
  amount: bigint,
  poolSwapFee: bigint,
  withdrawalProtocolFee: bigint,
  feeDenominator: bigint = EVM_POOL_FEE_DENOMINATOR
): bigint {
  if (amount < 0n) throw new Error("Amount should not be negative");
  if (poolSwapFee === 0n || withdrawalProtocolFee === 0n) return 0n;

  return computeFee(
    amount,
    poolSwapFee / withdrawalProtocolFee,
    feeDenominator
  );
}
