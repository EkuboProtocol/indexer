import { describe, expect, it } from "bun:test";
import { requireEvmRpcUrl, requireStarknetRpcUrl } from "./streamEndpoints";

for (const [name, parse] of [["EVM_RPC_URL", requireEvmRpcUrl], ["STARKNET_RPC_URL", requireStarknetRpcUrl]] as const) {
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
