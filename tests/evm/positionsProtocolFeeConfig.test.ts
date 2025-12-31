import { describe, expect, test } from "bun:test";
import { parsePositionsProtocolFeeConfigs } from "../../src/evm/positionsProtocolFeeConfig";

describe("parsePositionsProtocolFeeConfigs", () => {
  test("returns undefined for missing or empty input", () => {
    expect(parsePositionsProtocolFeeConfigs(undefined)).toBeUndefined();
    expect(parsePositionsProtocolFeeConfigs("")).toBeUndefined();
    expect(parsePositionsProtocolFeeConfigs(" , , ")).toBeUndefined();
  });

  test("parses multiple entries with optional withdrawal divisor", () => {
    const configs = parsePositionsProtocolFeeConfigs(
      "0x0000000000000000000000000000000000000001:10:2,0x0000000000000000000000000000000000000002:5"
    );

    expect(configs).toEqual([
      {
        address: "0x0000000000000000000000000000000000000001",
        swapProtocolFee: 10n,
        withdrawalProtocolFeeDivisor: 2n,
      },
      {
        address: "0x0000000000000000000000000000000000000002",
        swapProtocolFee: 5n,
        withdrawalProtocolFeeDivisor: 0n,
      },
    ]);
  });

  test("throws on malformed address", () => {
    expect(() =>
      parsePositionsProtocolFeeConfigs("not-an-address:1")
    ).toThrow("Invalid positions contract address");
  });

  test("throws on out-of-range swap fee", () => {
    const overMax = (1n << 64n).toString();
    expect(() =>
      parsePositionsProtocolFeeConfigs(
        `0x0000000000000000000000000000000000000001:${overMax}`
      )
    ).toThrow("Swap protocol fee must be between 0");
  });

  test("throws on negative withdrawal divisor", () => {
    expect(() =>
      parsePositionsProtocolFeeConfigs(
        "0x0000000000000000000000000000000000000001:10:-1"
      )
    ).toThrow("Withdrawal protocol fee divisor must be >= 0");
  });
});
