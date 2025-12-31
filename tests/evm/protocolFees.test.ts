import { describe, expect, test } from "bun:test";
import {
  calculateSwapProtocolFeeDelta,
  calculateWithdrawalProtocolFeeDelta,
  divFloor,
  EVM_POOL_FEE_DENOMINATOR,
} from "../../src/evm/protocolFees";
import { parsePositionsProtocolFeeConfigs } from "../../src/evm/positionsProtocolFeeConfig";

describe("positions protocol fee helpers", () => {
  test("performs floor division with signed operands", () => {
    expect(divFloor(7n, 3n)).toBe(2n);
    expect(divFloor(-7n, 3n)).toBe(-3n);
    expect(divFloor(7n, -3n)).toBe(-3n);
    expect(divFloor(9n, 3n)).toBe(3n);
    expect(() => divFloor(1n, 0n)).toThrow("Division by zero");
  });

  test("parses comma-delimited protocol fee configs", () => {
    const configs = parsePositionsProtocolFeeConfigs(
      [
        "0x0000000000000000000000000000000000000001:123:2",
        "0x0000000000000000000000000000000000000002:0",
      ].join(",")
    );

    expect(configs).toEqual([
      {
        address: "0x0000000000000000000000000000000000000001",
        swapProtocolFee: 123n,
        withdrawalProtocolFeeDivisor: 2n,
      },
      {
        address: "0x0000000000000000000000000000000000000002",
        swapProtocolFee: 0n,
        withdrawalProtocolFeeDivisor: 0n,
      },
    ]);

    expect(parsePositionsProtocolFeeConfigs("   ")).toBeUndefined();
  });

  test("calculates swap protocol fees on collected amounts", () => {
    const halfFee = EVM_POOL_FEE_DENOMINATOR >> 1n;
    expect(calculateSwapProtocolFeeDelta(100n, halfFee)).toBe(-50n);
    expect(calculateSwapProtocolFeeDelta(100n, 0n)).toBe(0n);
    expect(calculateSwapProtocolFeeDelta(0n, halfFee)).toBe(0n);
  });

  test("calculates withdrawal protocol fees with floor division", () => {
    const tenPercentFee = EVM_POOL_FEE_DENOMINATOR / 10n;
    // Applying a 10% protocol fee on a withdrawal should charge an extra swap equivalent
    // that is slightly more than 10% due to the denominator adjustment.
    expect(
      calculateWithdrawalProtocolFeeDelta(-100n, tenPercentFee)
    ).toBe(-12n);

    expect(calculateWithdrawalProtocolFeeDelta(100n, tenPercentFee)).toBe(0n);
    expect(calculateWithdrawalProtocolFeeDelta(-50n, 0n)).toBe(0n);
  });
});
