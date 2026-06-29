import { describe, expect, it } from "bun:test";
import { isEvmBlock } from "./evm";
import { isStarknetBlock } from "./starknet";
import { isNetworkTypeValid } from "./types";

describe("network entrypoint guards", () => {
  it("validates known network types", () => {
    expect(isNetworkTypeValid("evm")).toBeTrue();
    expect(isNetworkTypeValid("starknet")).toBeTrue();
    expect(isNetworkTypeValid("solana")).toBeFalse();
    expect(isNetworkTypeValid(undefined)).toBeFalse();
  });

  it("detects EVM and Starknet blocks", () => {
    expect(isEvmBlock({ logs: [] })).toBeTrue();
    expect(isEvmBlock({ events: [] })).toBeFalse();

    expect(isStarknetBlock({ events: [] })).toBeTrue();
    expect(isStarknetBlock({ logs: [] })).toBeFalse();
  });
});
