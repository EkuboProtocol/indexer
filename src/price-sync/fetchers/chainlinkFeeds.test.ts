import { describe, expect, test } from "bun:test";
import {
  chainlinkFeedMaxAgeSeconds,
  discoverChainlinkFeeds,
  fetchChainlinkFeedCatalog,
  fetchChainlinkTokenPricesWithMulticall,
  parseChainlinkPriceConfig,
  readChainlinkFeedPrice,
  resetVerifiedChainlinkClients,
  verifiedClient,
  type ChainlinkFeedConfig,
} from "./chainlinkFeeds";

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

describe("chainlinkFeedMaxAgeSeconds", () => {
  test("doubles a sub-daily heartbeat", () => {
    expect(chainlinkFeedMaxAgeSeconds(1200)).toBe(2400);
    expect(chainlinkFeedMaxAgeSeconds(3600)).toBe(7200);
  });

  test("carries a daily-heartbeat feed across a holiday weekend", () => {
    // An equity feed publishes only while its market is open. Friday's close
    // to Tuesday's open is about 89 hours, which doubling the heartbeat (48h)
    // does not survive.
    const holidayWeekendSeconds = 89 * 60 * 60;
    expect(chainlinkFeedMaxAgeSeconds(86400)).toBeGreaterThan(
      holidayWeekendSeconds,
    );
    expect(chainlinkFeedMaxAgeSeconds(86400)).toBe(5 * 24 * 60 * 60);
  });

  test("keeps doubling when that already exceeds the closure floor", () => {
    expect(chainlinkFeedMaxAgeSeconds(4 * 24 * 60 * 60)).toBe(
      8 * 24 * 60 * 60,
    );
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
          secondaryProxyAddress: "0x0000000000000000000000000000000000000006",
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

  test("skips entries whose heartbeat is implausibly large", () => {
    // A heartbeat this size would produce a validity horizon beyond the JS
    // Date range, costing the chain's whole batch rather than one feed.
    expect(
      discoverChainlinkFeeds(
        [
          {
            proxyAddress: feedAddress,
            heartbeat: 1e13,
            path: "eth-usd",
            feedCategory: "low",
            docs: {
              baseAsset: "ETH",
              quoteAsset: "USD",
              deliveryChannelCode: "DF",
              productType: "Price",
              productTypeCode: "RefPrice",
            },
          },
        ],
        [{ address: tokenAddress, symbol: "ETH" }],
      ),
    ).toEqual([]);
  });

  test("supports shared-SVR underlying proxies and tokenized prices", () => {
    const feed = (
      baseAsset: string,
      productTypeCode: string,
      address: string,
    ) => ({
      proxyAddress: address,
      secondaryProxyAddress: "0x0000000000000000000000000000000000000008",
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

describe("fetchChainlinkFeedCatalog", () => {
  function response(body: unknown, ok = true) {
    return async () =>
      ({
        ok,
        status: ok ? 200 : 500,
        statusText: ok ? "OK" : "Server Error",
        json: async () => body,
      }) as unknown as Response;
  }

  test("rejects a 200 response that is not an array", async () => {
    // Otherwise the body is cached and throws on every read until it expires.
    await expect(
      fetchChainlinkFeedCatalog(
        "https://catalog.example/feeds.json",
        response({ error: "temporarily unavailable" }),
      ),
    ).rejects.toThrow("did not return an array");
  });

  test("returns the catalog array unchanged", async () => {
    await expect(
      fetchChainlinkFeedCatalog(
        "https://catalog.example/feeds.json",
        response([{ path: "eth-usd" }]),
      ),
    ).resolves.toEqual([{ path: "eth-usd" }]);
  });
});

describe("readChainlinkFeedPrice", () => {
  const feed: ChainlinkFeedConfig = {
    tokenAddress,
    feedAddress,
    maxAgeSeconds: 3600,
  };

  function reader(
    roundData: readonly [bigint, bigint, bigint, bigint, bigint],
  ) {
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
      readChainlinkFeedPrice(reader([10n, 123_456_789n, 0n, 0n, 10n]), feed),
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

    const prices = await fetchChainlinkTokenPricesWithMulticall(reader, "1", {
      rpcUrls: ["https://rpc.example"],
      feeds: [
        { tokenAddress, feedAddress, maxAgeSeconds: 3600 },
        {
          tokenAddress: "0x0000000000000000000000000000000000000003",
          feedAddress: "0x0000000000000000000000000000000000000004",
          maxAgeSeconds: 3600,
        },
      ],
    });

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

describe("verifiedClient", () => {
  const fake = (chainId: number, calls: { n: number }) =>
    ({
      getChainId: async () => {
        calls.n++;
        return chainId;
      },
    }) as never;

  test("asks the chain for its ID once, not once per price fetch", async () => {
    // This runs on a timer, once a minute per configured chain. Re-verifying
    // every time was four eth_chainId calls a minute answering a question whose
    // answer is a property of the endpoint and cannot change.
    resetVerifiedChainlinkClients();
    const calls = { n: 0 };
    const create = () => fake(1, calls);

    const first = await verifiedClient("1", ["https://rpc.example"], create);
    for (let i = 0; i < 10; i++) {
      const again = await verifiedClient("1", ["https://rpc.example"], create);
      expect(again).toBe(first);
    }
    expect(calls.n).toBe(1);
  });

  test("shares one check between callers racing on a cold cache", async () => {
    resetVerifiedChainlinkClients();
    const calls = { n: 0 };
    const create = () => fake(1, calls);

    await Promise.all(
      Array.from({ length: 8 }, () =>
        verifiedClient("1", ["https://rpc.example"], create),
      ),
    );
    expect(calls.n).toBe(1);
  });

  test("keeps a separate client per chain and per endpoint set", async () => {
    resetVerifiedChainlinkClients();
    const calls = { n: 0 };

    const a = await verifiedClient("1", ["https://a"], () => fake(1, calls));
    const b = await verifiedClient("10", ["https://b"], () => fake(10, calls));
    const c = await verifiedClient("1", ["https://c"], () => fake(1, calls));

    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(calls.n).toBe(3);
  });

  test("rejects an endpoint serving a different chain", async () => {
    resetVerifiedChainlinkClients();
    const calls = { n: 0 };
    await expect(
      verifiedClient("1", ["https://wrong"], () => fake(137, calls)),
    ).rejects.toThrow(/returned chain ID 137/);
  });

  test("does not cache a failed check, so a blip cannot disable the chain", async () => {
    // A misconfigured URL fails again next minute at no cost. A transient
    // network error during the first check must not be remembered forever.
    resetVerifiedChainlinkClients();
    let attempt = 0;
    const create = () =>
      ({
        getChainId: async () => {
          attempt++;
          if (attempt === 1) throw new Error("connection reset");
          return 1;
        },
      }) as never;

    await expect(
      verifiedClient("1", ["https://flaky"], create),
    ).rejects.toThrow(/connection reset/);

    const client = await verifiedClient("1", ["https://flaky"], create);
    expect(client).toBeDefined();
    expect(attempt).toBe(2);
  });
});
