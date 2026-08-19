import { describe, expect, it } from "bun:test";
import {
  parseEvmRpcUrls,
  parseOptionalPositiveInteger,
  parseOptionalUrl,
  requireStarknetRpcUrl,
} from "./streamEndpoints";

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
    expect(
      requireStarknetRpcUrl(" https://api.cartridge.gg/x/starknet/mainnet "),
    ).toBe("https://api.cartridge.gg/x/starknet/mainnet");
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

describe("parseOptionalUrl", () => {
  it("returns a trimmed value", () => {
    expect(parseOptionalUrl(" wss://api.cartridge.gg/x/starknet/mainnet ")).toBe(
      "wss://api.cartridge.gg/x/starknet/mainnet",
    );
  });

  it("returns undefined for missing or blank values", () => {
    expect(parseOptionalUrl(undefined)).toBeUndefined();
    expect(parseOptionalUrl("   ")).toBeUndefined();
  });
});

describe("parseOptionalPositiveInteger", () => {
  it("parses a positive integer", () => {
    expect(parseOptionalPositiveInteger(" 25 ", "RPS")).toBe(25);
  });

  it("returns undefined for missing or blank values", () => {
    expect(parseOptionalPositiveInteger(undefined, "RPS")).toBeUndefined();
    expect(parseOptionalPositiveInteger("  ", "RPS")).toBeUndefined();
  });

  it("throws for values that are not positive integers", () => {
    expect(() => parseOptionalPositiveInteger("0", "RPS")).toThrow(
      'RPS must be a positive integer, got "0"',
    );
    expect(() => parseOptionalPositiveInteger("-1", "RPS")).toThrow(
      'RPS must be a positive integer, got "-1"',
    );
    expect(() => parseOptionalPositiveInteger("1.5", "RPS")).toThrow(
      'RPS must be a positive integer, got "1.5"',
    );
    expect(() => parseOptionalPositiveInteger("many", "RPS")).toThrow(
      'RPS must be a positive integer, got "many"',
    );
  });
});
