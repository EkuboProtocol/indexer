import { describe, expect, it } from "bun:test";
import { parseEvmRpcUrls, requireStarknetApibaraUrl } from "./streamEndpoints";

describe("parseEvmRpcUrls", () => {
  it("splits and trims comma-separated urls", () => {
    expect(parseEvmRpcUrls(" https://a.rpc ,https://b.rpc ")).toEqual([
      "https://a.rpc",
      "https://b.rpc",
    ]);
  });

  it("returns an empty array for missing or blank values", () => {
    expect(parseEvmRpcUrls(undefined)).toEqual([]);
    expect(parseEvmRpcUrls(" ,  ")).toEqual([]);
  });
});

describe("requireStarknetApibaraUrl", () => {
  it("returns a trimmed value", () => {
    expect(requireStarknetApibaraUrl(" https://mainnet.starkstream.io ")).toBe(
      "https://mainnet.starkstream.io",
    );
  });

  it("throws when missing", () => {
    expect(() => requireStarknetApibaraUrl(undefined)).toThrow(
      "Missing APIBARA_URL",
    );
    expect(() => requireStarknetApibaraUrl("   ")).toThrow(
      "Missing APIBARA_URL",
    );
  });
});
