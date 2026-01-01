import { describe, expect, test } from "bun:test";
import {
  computeFee,
  calculateWithdrawalProtocolFeeDelta,
  EVM_POOL_FEE_DENOMINATOR,
} from "../../src/evm/protocolFees";
import { parsePositionsProtocolFeeConfigs } from "../../src/evm/positionsProtocolFeeConfig";

describe("positions protocol fee helpers", () => {
  test("parses comma-delimited protocol fee configs", () => {
    const configs = parsePositionsProtocolFeeConfigs(
      "0x0000000000000000000000000000000000000001:123:2,0x0000000000000000000000000000000000000002:2,0x0000000000000000000000000000000000000003"
    );

    expect(configs).toEqual([
      {
        address: "0x0000000000000000000000000000000000000001",
        swapProtocolFee: 123n,
        withdrawalProtocolFeeDivisor: 2n,
      },
      {
        address: "0x0000000000000000000000000000000000000002",
        swapProtocolFee: 2n,
        withdrawalProtocolFeeDivisor: 0n,
      },
      {
        address: "0x0000000000000000000000000000000000000003",
        swapProtocolFee: 0n,
        withdrawalProtocolFeeDivisor: 0n,
      },
    ]);

    expect(parsePositionsProtocolFeeConfigs("   ")).toBeUndefined();
  });

  describe("computeFee", () => {
    test("zero", () => {
      expect(computeFee(0n, 0n)).toEqual(0n);
      expect(computeFee(1n, 0n)).toEqual(0n);
      expect(computeFee(1n << 128n, 0n)).toEqual(0n);
      expect(computeFee(0n, EVM_POOL_FEE_DENOMINATOR >> 1n)).toEqual(0n);
    });

    test("nonzero", () => {
      expect(computeFee(100n, EVM_POOL_FEE_DENOMINATOR >> 1n)).toEqual(50n);
      // rounds up
      expect(computeFee(101n, EVM_POOL_FEE_DENOMINATOR >> 1n)).toEqual(51n);
      // rounds up
      expect(computeFee(1n, EVM_POOL_FEE_DENOMINATOR >> 1n)).toEqual(1n);
    });
  });

  describe("calculateWithdrawalProtocolFeeDelta", () => {
    test("treats zero denominator correctly", () => {
      expect(
        calculateWithdrawalProtocolFeeDelta(
          100n,
          EVM_POOL_FEE_DENOMINATOR >> 1n,
          0n
        )
      ).toBe(0n);
    });

    test("treats zero amount correctly", () => {
      expect(
        calculateWithdrawalProtocolFeeDelta(
          0n,
          EVM_POOL_FEE_DENOMINATOR >> 1n,
          1n
        )
      ).toBe(0n);
    });

    test("treats one correctly", () => {
      expect(
        calculateWithdrawalProtocolFeeDelta(
          100n,
          EVM_POOL_FEE_DENOMINATOR >> 1n,
          1n
        )
      ).toBe(50n);
    });

    test("zero fee", () => {
      expect(calculateWithdrawalProtocolFeeDelta(100n, 0n, 1n)).toBe(0n);
    });

    test("negative amount throws", () => {
      expect(() => calculateWithdrawalProtocolFeeDelta(-1n, 0n, 1n)).toThrow(
        "Amount should not be negative"
      );
    });

    test("calculates withdrawal protocol fees as fraction of swap pool fee", () => {
      expect(
        calculateWithdrawalProtocolFeeDelta(
          100n,
          EVM_POOL_FEE_DENOMINATOR >> 1n,
          10n
        )
      ).toBe(5n);
    });
  });
});
