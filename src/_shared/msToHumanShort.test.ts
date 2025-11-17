import { describe, expect, it } from "bun:test";
import { msToHumanShort } from "./msToHumanShort";

describe("msToHumanShort", () => {
  it("returns 0ms for zero input", () => {
    expect(msToHumanShort(0)).toBe("0ms");
  });

  it("formats basic units", () => {
    expect(msToHumanShort(999)).toBe("999ms");
    expect(msToHumanShort(1000)).toBe("1s");
    expect(msToHumanShort(61_000)).toBe("1min, 1s");
  });

  it("limits the output to three components", () => {
    const input =
      2 * 86_400_000 + // 2d
      3 * 3_600_000 + // 3h
      4 * 60_000 + // 4min
      5 * 1000 + // 5s
      6; // 6ms

    expect(msToHumanShort(input)).toBe("2d, 3h, 4min");
  });
});
