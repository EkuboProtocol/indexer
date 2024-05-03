import { FieldElement } from "@apibara/starknet";
import { parsePoolKey } from "./events/core";
import { describe, it, expect } from "vitest";

describe("parse", () => {
  describe(parsePoolKey, () => {
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
          token0: 5n,
          token1: 4n,
          fee: 0x3n,
          tick_spacing: 0x2n,
          extension: 1n,
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
          token0: 2n,
          token1: 1n,
          fee: 0x2n,
          tick_spacing: 0x3n,
          extension: 4n,
        },
      });
    });
  });
});
