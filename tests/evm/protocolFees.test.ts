import { describe, expect, test } from "bun:test";
import {
  calculateSwapProtocolFeeDelta,
  calculateWithdrawalProtocolFeeDelta,
} from "../../src/evm/logProcessors";
import { parsePositionsProtocolFeeConfigs } from "../../src/evm/positionsProtocolFeeConfig";

const FEE_DENOMINATOR = 1n << 64n;

describe("positions protocol fee helpers", () => {
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
    const halfFee = 1n << 63n;
    expect(calculateSwapProtocolFeeDelta(100n, halfFee)).toBe(-50n);
    expect(calculateSwapProtocolFeeDelta(100n, 0n)).toBe(0n);
    expect(calculateSwapProtocolFeeDelta(0n, halfFee)).toBe(0n);
  });

  test("calculates withdrawal protocol fees with floor division", () => {
    const tenPercentFee = FEE_DENOMINATOR / 10n;
    // Applying a 10% protocol fee on a withdrawal should charge an extra swap equivalent
    // that is slightly more than 10% due to the denominator adjustment.
    expect(
      calculateWithdrawalProtocolFeeDelta(-100n, tenPercentFee)
    ).toBe(-12n);

    expect(calculateWithdrawalProtocolFeeDelta(100n, tenPercentFee)).toBe(0n);
    expect(calculateWithdrawalProtocolFeeDelta(-50n, 0n)).toBe(0n);
  });
});
