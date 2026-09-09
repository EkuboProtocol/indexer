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

    // Both networks now deliver the same shape, because both are read by the
    // shared block stream: `logs`, and a base fee already resolved to a bigint
    // rather than an apibara `l2GasPrice.priceInFri`.
    expect(
      parseStarknetBlockHeader({
        logs: [],
        header: {
          blockNumber: 789n,
          blockHash: "0xdef",
          timestamp,
          baseFeePerGas: 0x123n,
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

    // A block missing the events array, or the header, is not usable on either.
    expect(parseEvmBlockHeader({ events: [] })).toBeNull();
    expect(parseStarknetBlockHeader({ events: [] })).toBeNull();
    expect(parseStarknetBlockHeader({ logs: [] })).toBeNull();
  });
});


it("rejects missing hashes and negative block numbers", () => {
  for (const parse of [parseEvmBlockHeader, parseStarknetBlockHeader]) {
    expect(parse({ logs: [], header: { blockNumber: 1n, timestamp: new Date() } })).toBeNull();
    expect(parse({ logs: [], header: { blockNumber: -1n, blockHash: "0x1", timestamp: new Date() } })).toBeNull();
  }
});
