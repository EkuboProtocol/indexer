import { describe, expect, test } from "bun:test";
import {
  loadHexAddresses,
  loadOptionalHexAddress,
} from "../src/_shared/loadHexAddresses";

describe("loadHexAddresses", () => {
  test("returns typed addresses when all env vars exist and are hex", () => {
    const env = {
      CORE_ADDRESS: "0xabc123",
      TWAMM_ADDRESS: "  0xDEF456  ",
    } satisfies Record<string, string>;

    const result = loadHexAddresses(
      {
        coreAddress: "CORE_ADDRESS",
        twammAddress: "TWAMM_ADDRESS",
      },
      env
    );

    expect(result).toEqual({
      coreAddress: "0xabc123",
      twammAddress: "0xDEF456",
    });
  });

  test("returns undefined when an env var is missing", () => {
    const env = {
      CORE_ADDRESS: "0xabc123",
    } satisfies Record<string, string>;

    const result = loadHexAddresses(
      {
        coreAddress: "CORE_ADDRESS",
        twammAddress: "TWAMM_ADDRESS",
      },
      env
    );

    expect(result).toBeUndefined();
  });

  test("returns undefined when an env var is malformed", () => {
    const env = {
      CORE_ADDRESS: "0xabc123",
      TWAMM_ADDRESS: "not-hex",
    } satisfies Record<string, string>;

    const result = loadHexAddresses(
      {
        coreAddress: "CORE_ADDRESS",
        twammAddress: "TWAMM_ADDRESS",
      },
      env
    );

    expect(result).toBeUndefined();
  });

  test("loads optional addresses only when present", () => {
    expect(
      loadOptionalHexAddress("LEGACY_TWAMM_V3_ADDRESS", {
        LEGACY_TWAMM_V3_ADDRESS: "  0xabc123  ",
      })
    ).toBe("0xabc123");

    expect(loadOptionalHexAddress("LEGACY_TWAMM_V3_ADDRESS", {})).toBe(
      undefined
    );
  });

  test("throws when an optional address is present but malformed", () => {
    expect(() =>
      loadOptionalHexAddress("LEGACY_TWAMM_V3_ADDRESS", {
        LEGACY_TWAMM_V3_ADDRESS: "not-hex",
      })
    ).toThrow('Invalid hex address for LEGACY_TWAMM_V3_ADDRESS: "not-hex"');
  });
});
