import { describe, expect, it } from "bun:test";
import { requireEvmRpcUrls, requireStarknetRpcUrl } from "./streamEndpoints";

for (const [name, parse] of [["STARKNET_RPC_URL", requireStarknetRpcUrl]] as const) {
  describe(name, () => {
    it("accepts a trimmed single HTTP endpoint", () => {
      expect(parse(" https://rpc.example/v2/key ")).toBe("https://rpc.example/v2/key");
      expect(parse("http://localhost:8545")).toBe("http://localhost:8545");
    });
    it("rejects missing values", () => {
      for (const value of [undefined, "", "   "]) {
        expect(() => parse(value)).toThrow(`Missing ${name}`);
      }
    });
    it("rejects lists instead of silently choosing an endpoint", () => {
      for (const value of ["https://a,https://b", "https://a,", "https://a https://b", "https://a\nhttps://b"]) {
        expect(() => parse(value)).toThrow(/single/);
      }
    });
    it("rejects malformed and unsupported URLs without exposing credentials", () => {
      for (const value of ["not-a-url", "wss://rpc.example/secret", "file:///secret"]) {
        expect(() => parse(value)).toThrow(/HTTP\(S\)/);
        try { parse(value); } catch (error) { expect(String(error)).not.toContain(value); }
      }
    });
  });
}

describe("EVM_RPC_URL", () => {
  it("accepts one endpoint or an ordered, trimmed list", () => {
    expect(requireEvmRpcUrls(" https://rpc.example/v2/key ")).toEqual(["https://rpc.example/v2/key"]);
    expect(requireEvmRpcUrls("https://a.example/v2/k, https://b.example/?dkey=d"))
      .toEqual(["https://a.example/v2/k", "https://b.example/?dkey=d"]);
  });
  it("rejects missing values, empty entries and duplicates", () => {
    for (const value of [undefined, "", "   "]) expect(() => requireEvmRpcUrls(value)).toThrow("Missing EVM_RPC_URL");
    expect(() => requireEvmRpcUrls("https://a,")).toThrow(/empty entry/);
    expect(() => requireEvmRpcUrls("https://a,https://a")).toThrow(/twice/);
  });
  it("rejects malformed entries without exposing credentials", () => {
    for (const value of ["https://a https://b", "https://a,wss://rpc.example/secret", "not-a-url"]) {
      expect(() => requireEvmRpcUrls(value)).toThrow(/EVM_RPC_URL/);
      try { requireEvmRpcUrls(value); } catch (error) { expect(String(error)).not.toContain("secret"); }
    }
  });
});
