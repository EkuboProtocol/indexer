import { describe, expect, it } from "bun:test";
import { parseEvmRpcUrls, requireStarknetRpcUrl } from "./streamEndpoints";

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

describe("requireStarknetRpcUrl", () => {
  it("returns a trimmed value", () => {
    expect(requireStarknetRpcUrl(" https://starknet-mainnet.example/rpc ")).toBe(
      "https://starknet-mainnet.example/rpc",
    );
  });

  it("throws when missing", () => {
    expect(() => requireStarknetRpcUrl(undefined)).toThrow(
      "Missing STARKNET_RPC_URL",
    );
    expect(() => requireStarknetRpcUrl("   ")).toThrow(
      "Missing STARKNET_RPC_URL",
    );
  });
});
