import { describe, expect, test } from "bun:test";
import {
  fetchChainlinkTokenPrices,
  parseChainlinkPriceConfig,
  readChainlinkFeedPrice,
  type ChainlinkFeedConfig,
} from "./chainlinkTokenPrices";

const tokenAddress = "0x0000000000000000000000000000000000000001";
const feedAddress = "0x0000000000000000000000000000000000000002";

describe("parseChainlinkPriceConfig", () => {
  test("parses per-chain RPC and feed lists", () => {
    expect(
      parseChainlinkPriceConfig(
        JSON.stringify({
          1: {
            rpcUrls: ["https://rpc.example"],
            feeds: [{ tokenAddress, feedAddress, maxAgeSeconds: 3600 }],
          },
        }),
      ),
    ).toEqual({
      1: {
        rpcUrls: ["https://rpc.example"],
        feeds: [{ tokenAddress, feedAddress, maxAgeSeconds: 3600 }],
      },
    });
  });

  test("rejects duplicate tokens on a chain", () => {
    expect(() =>
      parseChainlinkPriceConfig(
        JSON.stringify({
          1: {
            rpcUrls: ["https://rpc.example"],
            feeds: [
              { tokenAddress, feedAddress, maxAgeSeconds: 3600 },
              { tokenAddress, feedAddress, maxAgeSeconds: 3600 },
            ],
          },
        }),
      ),
    ).toThrow("duplicate token");
  });
});

describe("readChainlinkFeedPrice", () => {
  const feed: ChainlinkFeedConfig = {
    tokenAddress,
    feedAddress,
    maxAgeSeconds: 3600,
  };

  function reader(roundData: readonly [bigint, bigint, bigint, bigint, bigint]) {
    return {
      async readContract({ functionName }: { functionName: string }) {
        return functionName === "decimals" ? 8 : roundData;
      },
    };
  }

  test("normalizes the answer using feed decimals", async () => {
    const observation = await readChainlinkFeedPrice(
      reader([10n, 123_456_789n, 0n, 9_900n, 10n]),
      feed,
      10_000,
    );
    expect(observation).toEqual({
      usdPrice: 1.23456789,
      timestamp: new Date(9_900_000),
    });
  });

  test("rejects stale answers", async () => {
    await expect(
      readChainlinkFeedPrice(
        reader([10n, 123_456_789n, 0n, 6_399n, 10n]),
        feed,
        10_000,
      ),
    ).rejects.toThrow("older than 3600 seconds");
  });

  test("rejects incomplete and superseded rounds", async () => {
    await expect(
      readChainlinkFeedPrice(
        reader([10n, 123_456_789n, 0n, 0n, 10n]),
        feed,
      ),
    ).rejects.toThrow("incomplete");
    await expect(
      readChainlinkFeedPrice(
        reader([10n, 123_456_789n, 0n, 9_900n, 9n]),
        feed,
        10_000,
      ),
    ).rejects.toThrow("old round");
  });
});

describe("fetchChainlinkTokenPrices", () => {
  test("sends all feed calls in one batch RPC request", async () => {
    type RpcRequest = {
      id: number;
      method: string;
      params?: [{ data?: string }];
    };

    const requests: (RpcRequest | RpcRequest[])[] = [];
    const uint256Word = (value: bigint) => value.toString(16).padStart(64, "0");
    const updatedAt = BigInt(Math.floor(Date.now() / 1_000));
    const decimalsResult = `0x${uint256Word(8n)}`;
    const roundDataResult = `0x${[
      10n,
      123_456_789n,
      updatedAt,
      updatedAt,
      10n,
    ]
      .map(uint256Word)
      .join("")}`;

    const fetchFn = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
      requests.push(body);

      const respond = (rpcRequest: RpcRequest) => ({
        jsonrpc: "2.0",
        id: rpcRequest.id,
        result:
          rpcRequest.method === "eth_chainId"
            ? "0x1"
            : rpcRequest.params?.[0].data?.startsWith("0x313ce567")
              ? decimalsResult
              : roundDataResult,
      });

      return Response.json(
        Array.isArray(body) ? body.map(respond) : respond(body),
      );
    };

    const prices = await fetchChainlinkTokenPrices(
      "1",
      {
        rpcUrls: ["https://rpc.example"],
        feeds: [
          { tokenAddress, feedAddress, maxAgeSeconds: 3600 },
          {
            tokenAddress: "0x0000000000000000000000000000000000000003",
            feedAddress: "0x0000000000000000000000000000000000000004",
            maxAgeSeconds: 3600,
          },
        ],
      },
      fetchFn,
    );

    expect(Object.keys(prices)).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(Array.isArray(requests[0])).toBe(true);
    expect(Array.isArray(requests[1])).toBe(true);
    expect(requests[0]).toHaveLength(1);
    expect(requests[1]).toHaveLength(4);
  });
});
