import { describe, expect, it } from "vitest";
import { FieldElement } from "@apibara/starknet";
import { parseByteArray } from "./core";

describe(parseByteArray, () => {
  it.each([
    {
      data: [0n, 0x68656c6c6fn, 5n],
      startingFrom: 0,
      expected: { next: 3, value: "hello" },
    },
    {
      data: [123n, 0n, 0x68656c6c6fn, 5n],
      startingFrom: 1,
      expected: { next: 4, value: "hello" },
    },
    {
      data: [
        1n,
        0x4c6f6e6720737472696e672c206d6f7265207468616e203331206368617261n,
        0x63746572732en,
        6n,
      ],
      startingFrom: 0,
      expected: { next: 4, value: "Long string, more than 31 characters." },
    },
    {
      data: [
        0n,
        1n,
        0x4c6f6e6720737472696e672c206d6f7265207468616e203331206368617261n,
        0x63746572732en,
        6n,
        0n,
      ],
      startingFrom: 1,
      expected: { next: 5, value: "Long string, more than 31 characters." },
    },
  ])(
    "parseByteArray($data) = $expected",
    ({ data, startingFrom, expected }) => {
      expect(
        parseByteArray(
          data.map((x) => FieldElement.fromBigInt(x)),
          startingFrom
        )
      ).toEqual(expected);
    }
  );
});
