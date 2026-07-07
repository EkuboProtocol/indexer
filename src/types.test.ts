import { describe, expect, it } from "bun:test";
import { parseEvmBlockHeader } from "./evm";
import { parseStarknetBlockHeader } from "./starknet";
import { isNetworkTypeValid } from "./types";

describe("network entrypoint guards", () => {
  it("validates known network types", () => {
    expect(isNetworkTypeValid("evm")).toBeTrue();
    expect(isNetworkTypeValid("starknet")).toBeTrue();
    expect(isNetworkTypeValid("solana")).toBeFalse();
    expect(isNetworkTypeValid(undefined)).toBeFalse();
  });

  it("parses EVM and Starknet block headers", () => {
    const timestamp = new Date("2024-01-01T00:00:00.000Z");

    expect(
      parseEvmBlockHeader({
        logs: [],
        header: {
          blockNumber: 123n,
          blockHash: "0xabc",
          timestamp,
          baseFeePerGas: 456n,
        },
      }),
    ).toMatchObject({
      header: {
        number: 123,
        hash: 0xabcn,
        timestamp: timestamp.getTime(),
        baseFeePerGas: 456n,
      },
    });

    expect(
      parseStarknetBlockHeader({
        events: [],
        header: {
          blockNumber: 789n,
          blockHash: "0xdef",
          timestamp,
          l2GasPrice: { priceInFri: "0x123" },
        },
      }),
    ).toMatchObject({
      header: {
        number: 789,
        hash: 0xdefn,
        timestamp: timestamp.getTime(),
        baseFeePerGas: 0x123n,
      },
    });

    expect(parseEvmBlockHeader({ events: [] })).toBeNull();
    expect(parseStarknetBlockHeader({ logs: [] })).toBeNull();
  });
});
