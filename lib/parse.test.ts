import { parsePoolKey, PoolKey } from "./parse";
import { FieldElement } from "@apibara/starknet";

describe("parse", () => {
  describe("parsePoolKey", () => {
    it("works correctly for random data from 0", () => {
      const result = parsePoolKey(
        [
          FieldElement.fromBigInt(0x5n),
          FieldElement.fromBigInt(0x4n),
          FieldElement.fromBigInt(0x3n),
          FieldElement.fromBigInt(0x2n),
          FieldElement.fromBigInt(0x1n),
          FieldElement.fromBigInt(0x0n),
        ],
        0
      );

      expect(result).toEqual({
        next: 5,
        value: {
          token0:
            "0x0000000000000000000000000000000000000000000000000000000000000005",
          token1:
            "0x0000000000000000000000000000000000000000000000000000000000000004",
          fee: 0x3n,
          tick_spacing: 0x2n,
          extension:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
      });
    });

    it("works correctly for random data from random place", () => {
      const result = parsePoolKey(
        [
          FieldElement.fromBigInt(0x5n),
          FieldElement.fromBigInt(0x4n),
          FieldElement.fromBigInt(0x3n),
          FieldElement.fromBigInt(0x2n),
          FieldElement.fromBigInt(0x1n),
          FieldElement.fromBigInt(0x2n),
          FieldElement.fromBigInt(0x3n),
          FieldElement.fromBigInt(0x4n),
        ],
        3
      );

      expect(result).toEqual({
        next: 8,
        value: {
          token0:
            "0x0000000000000000000000000000000000000000000000000000000000000002",
          token1:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
          fee: 0x2n,
          tick_spacing: 0x3n,
          extension:
            "0x0000000000000000000000000000000000000000000000000000000000000004",
        },
      });
    });
  });
});
