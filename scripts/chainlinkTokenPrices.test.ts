import { describe, expect, test } from "bun:test";
import {
  discoverChainlinkFeeds,
  fetchChainlinkTokenPricesWithMulticall,
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

  test("accepts a catalog in place of explicit feeds", () => {
    expect(
      parseChainlinkPriceConfig(
        JSON.stringify({
          8453: {
            rpcUrls: ["https://rpc.example"],
            catalogUrl:
              "https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json",
          },
        }),
      ),
    ).toEqual({
      8453: {
        rpcUrls: ["https://rpc.example"],
        feeds: [],
        catalogUrl:
          "https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json",
      },
    });
  });
});

describe("discoverChainlinkFeeds", () => {
  test("matches unique trusted token symbols to standard USD feeds", () => {
    const standardFeed = {
      proxyAddress: feedAddress,
      heartbeat: 1200,
      path: "eth-usd",
      feedCategory: "low",
      docs: {
        baseAsset: "ETH",
        quoteAsset: "USD",
        deliveryChannelCode: "DF",
        productType: "Price",
        productTypeCode: "RefPrice",
      },
    };
    const feeds = discoverChainlinkFeeds(
      [
        standardFeed,
        {
          ...standardFeed,
          path: "eth-usd-svr",
          proxyAddress: "0x0000000000000000000000000000000000000005",
          secondaryProxyAddress:
            "0x0000000000000000000000000000000000000006",
        },
        {
          ...standardFeed,
          path: "link-usd",
          proxyAddress: "0x0000000000000000000000000000000000000007",
          docs: { ...standardFeed.docs, baseAsset: "LINK" },
        },
      ],
      [
        { address: tokenAddress, symbol: "ETH" },
        {
          address: "0x0000000000000000000000000000000000000003",
          symbol: "LINK",
        },
        {
          address: "0x0000000000000000000000000000000000000004",
          symbol: "LINK",
        },
      ],
    );

    expect(feeds).toEqual([
      {
        tokenAddress,
        feedAddress,
        maxAgeSeconds: 2400,
      },
    ]);
  });

  test("supports shared-SVR underlying proxies and tokenized prices", () => {
    const feed = (baseAsset: string, productTypeCode: string, address: string) =>
      ({
        proxyAddress: address,
        secondaryProxyAddress:
          "0x0000000000000000000000000000000000000008",
        heartbeat: 3600,
        path: `${baseAsset.toLowerCase()}-usd-shared-svr`,
        feedCategory: "low",
        docs: {
          baseAsset,
          quoteAsset: "USD",
          deliveryChannelCode: "DF",
          productType: "Price",
          productTypeCode,
        },
      });

    expect(
      discoverChainlinkFeeds(
        [
          feed("ETH", "RefPrice", feedAddress),
          feed(
            "AAPL",
            "primaryTokenizedPrice",
            "0x0000000000000000000000000000000000000009",
          ),
        ],
        [
          { address: tokenAddress, symbol: "ETH" },
          {
            address: "0x0000000000000000000000000000000000000003",
            symbol: "AAPL",
          },
        ],
      ),
    ).toEqual([
      {
        tokenAddress,
        feedAddress,
        maxAgeSeconds: 7200,
      },
      {
        tokenAddress: "0x0000000000000000000000000000000000000003",
        feedAddress: "0x0000000000000000000000000000000000000009",
        maxAgeSeconds: 7200,
      },
    ]);
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

describe("fetchChainlinkTokenPricesWithMulticall", () => {
  test("reads all feeds in one Multicall3 call", async () => {
    const updatedAt = BigInt(Math.floor(Date.now() / 1_000));
    const multicallArgs: unknown[] = [];
    const reader = {
      async multicall(args: unknown) {
        multicallArgs.push(args);
        return [
          { status: "success" as const, result: 8 },
          {
            status: "success" as const,
            result: [10n, 123_456_789n, updatedAt, updatedAt, 10n],
          },
          { status: "success" as const, result: 8 },
          {
            status: "success" as const,
            result: [10n, 200_000_000n, updatedAt, updatedAt, 10n],
          },
        ];
      },
    };

    const prices = await fetchChainlinkTokenPricesWithMulticall(
      reader,
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
    );

    expect(Object.keys(prices)).toHaveLength(2);
    expect(multicallArgs).toHaveLength(1);
    expect(multicallArgs[0]).toMatchObject({
      allowFailure: true,
      batchSize: Number.MAX_SAFE_INTEGER,
      multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11",
      contracts: [
        { address: feedAddress, functionName: "decimals" },
        { address: feedAddress, functionName: "latestRoundData" },
        {
          address: "0x0000000000000000000000000000000000000004",
          functionName: "decimals",
        },
        {
          address: "0x0000000000000000000000000000000000000004",
          functionName: "latestRoundData",
        },
      ],
    });
  });
});
