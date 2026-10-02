import { expect, test } from "bun:test";
import { Effect, Logger, Stream } from "effect";
import type { Sql } from "postgres";
import {
  agreesWithReferencePrices,
  chainlinkPriceFetcher,
  makeChainlinkRoundTracker,
} from "./chainlink";
import { makeChainlinkCatalogCache } from "./chainlinkCatalog";
import type {
  ChainlinkChainConfig,
  ChainlinkPriceObservation,
} from "./chainlinkFeeds";

const tokenAddress = "0x0000000000000000000000000000000000000001";
const feedAddress = "0x0000000000000000000000000000000000000002";

// The job queries indexed tokens before reaching the catalog; returning an
// empty set is enough for discovery to have nothing to add.
const sql = (async () => []) as unknown as Sql<{ bigint: bigint }>;

test("a catalog outage still reports explicitly configured feeds", async () => {
  const job = chainlinkPriceFetcher({
    sql,
    chainId: 1n,
    intervalMs: 60_000,
    config: {
      // Unroutable host: discovery fails with a cold cache.
      rpcUrls: ["https://rpc.invalid"],
      catalogUrl: "https://catalog.invalid/feeds.json",
      feeds: [{ tokenAddress, feedAddress, maxAgeSeconds: 3600 }],
    },
    catalogRefreshIntervalMs: 3_600_000,
    catalogCache: makeChainlinkCatalogCache(),
  });

  // Discovery must be swallowed, leaving the configured feed to be read. The
  // read itself then fails on the unroutable RPC -- a distinct failure, which
  // is what proves the override survived the catalog outage.
  let reachedFeedRead = false;
  try {
    await Effect.runPromise(Stream.runCollect(job.fetch));
  } catch (error) {
    reachedFeedRead = !/catalog/i.test(String(error));
  }

  expect(reachedFeedRead).toBe(true);
});

test("an unchanged round is reported once, not once per poll", () => {
  // A feed keeps returning its last round until it next publishes, so polling
  // faster than the heartbeat must not write a row per poll.
  const shouldReport = makeChainlinkRoundTracker();
  const round = new Date("2026-08-09T00:00:00Z");
  expect(shouldReport(1n, tokenAddress, round)).toBe(true);
  expect(shouldReport(1n, tokenAddress, round)).toBe(false);
  expect(shouldReport(1n, tokenAddress, round)).toBe(false);

  // A genuine publication is reported again.
  expect(shouldReport(1n, tokenAddress, new Date(round.getTime() + 1))).toBe(
    true,
  );
});

test("rounds are tracked per chain and per token", () => {
  const shouldReport = makeChainlinkRoundTracker();
  const round = new Date("2026-08-09T01:00:00Z");
  expect(shouldReport(8453n, tokenAddress, round)).toBe(true);
  // Same token address on a different chain is a different feed.
  expect(shouldReport(42161n, tokenAddress, round)).toBe(true);
  // As is a different token on the same chain.
  expect(shouldReport(8453n, feedAddress, round)).toBe(true);
  expect(shouldReport(8453n, tokenAddress, round)).toBe(false);
});

test("each job tracks its own rounds", () => {
  // The tracker used to be module-level state shared by every Chainlink job in
  // the process; keeping it per job is what lets these tests run in any order.
  const first = makeChainlinkRoundTracker();
  const second = makeChainlinkRoundTracker();
  const round = new Date("2026-08-09T02:00:00Z");

  expect(first(1n, tokenAddress, round)).toBe(true);
  expect(second(1n, tokenAddress, round)).toBe(true);
});

test("a chain with no configured feeds and no catalog yields nothing", async () => {
  const job = chainlinkPriceFetcher({
    sql,
    chainId: 1n,
    intervalMs: 60_000,
    config: { rpcUrls: ["https://rpc.invalid"], feeds: [] },
    catalogRefreshIntervalMs: 3_600_000,
    catalogCache: makeChainlinkCatalogCache(),
  });

  const batches = await Effect.runPromise(Stream.runCollect(job.fetch));
  expect(batches).toEqual([]);
});

test("a feed pricing a different asset than its token is withheld", () => {
  // Production cases: Base's OP is One Path, Base's TRUMP is MAGA, and
  // mainnet's FRAX is the dollar while the FRAX feed is the governance token.
  expect(agreesWithReferencePrices(0.1344, [0.000025, 0.000025])).toBe(false);
  expect(agreesWithReferencePrices(2.138, [0.0318, 0.0311])).toBe(false);
  expect(agreesWithReferencePrices(0.3163, [0.9921])).toBe(false);
});

test("a feed close to the market is kept", () => {
  expect(agreesWithReferencePrices(85_228, [85_191, 85_020])).toBe(true);
  // A bridged or thinly traded variant drifts further, and is still the same
  // asset: Binance's BETH against the market, Wormhole CELO against CoinGecko.
  expect(agreesWithReferencePrices(2694.6, [2982.5, 2979.2])).toBe(true);
  expect(agreesWithReferencePrices(0.1025, [0.1244])).toBe(true);
});

test("one agreeing source is enough to keep a feed", () => {
  // tBTC on mainnet: the quoter was 10% low through a thin pool while
  // SushiSwap agreed with Chainlink.
  expect(agreesWithReferencePrices(85_760, [60_000, 84_944])).toBe(true);
});

test("a token with no other current price keeps its feed", () => {
  expect(agreesWithReferencePrices(8.12, [])).toBe(true);
  // A zero or non-finite reference is no evidence either way.
  expect(agreesWithReferencePrices(8.12, [0, Number.NaN])).toBe(true);
});

// Four tokens, as `erc20_tokens` stores them: the address is numeric text.
// Three are priced by catalog discovery and one by configuration.
const collides = "0x00000000000000000000000000000000000000a1";
const agrees = "0x00000000000000000000000000000000000000a2";
const unpriced = "0x00000000000000000000000000000000000000a3";
const configured = "0x00000000000000000000000000000000000000A4";
const indexedTokens = [
  { token_address: "161", token_symbol: "AAA" },
  { token_address: "162", token_symbol: "BBB" },
  { token_address: "163", token_symbol: "CCC" },
  { token_address: "164", token_symbol: "DDD" },
];

const catalogEntry = (symbol: string, proxy: string) => ({
  proxyAddress: proxy,
  heartbeat: 3600,
  path: `${symbol.toLowerCase()}-usd`,
  feedCategory: "low",
  docs: {
    baseAsset: symbol,
    quoteAsset: "USD",
    deliveryChannelCode: "DF",
    productType: "Price",
    productTypeCode: "RefPrice",
  },
});
const catalog = [
  catalogEntry("AAA", "0x00000000000000000000000000000000000000f1"),
  catalogEntry("BBB", "0x00000000000000000000000000000000000000f2"),
  catalogEntry("CCC", "0x00000000000000000000000000000000000000f3"),
];

// What each feed answers, by proxy.
const feedAnswers: Record<string, number> = {
  "0x00000000000000000000000000000000000000f1": 100,
  "0x00000000000000000000000000000000000000f2": 100,
  "0x00000000000000000000000000000000000000f3": 100,
  "0x00000000000000000000000000000000000000f4": 100,
};

const IN_LIST = Symbol("sql(list)");

/**
 * Enough of `postgres` to answer the two queries the fetcher makes, holding
 * addresses the way the database does. A reference row is returned only when
 * its numeric address is in the list the fetcher asked for, so the test fails
 * if the hex observation keys stop matching the stored form in either
 * direction.
 */
function stubSql(references: { token_address: string; value: number }[]) {
  return ((first: unknown, ...values: unknown[]) => {
    if (!(Array.isArray(first) && "raw" in first)) return { [IN_LIST]: first };
    const query = first.join("?");
    if (query.includes("erc20_tokens_latest_price_by_source")) {
      const list = values.find(
        (value): value is { [IN_LIST]: string[] } =>
          typeof value === "object" && value !== null && IN_LIST in value,
      )![IN_LIST];
      return Promise.resolve(
        references.filter((row) => list.includes(row.token_address)),
      );
    }
    if (query.includes("FROM erc20_tokens")) {
      return Promise.resolve(indexedTokens);
    }
    throw new Error(`unexpected query: ${query}`);
  }) as unknown as Sql<{ bigint: bigint }>;
}

const round = new Date("2026-10-02T00:00:00Z");
const readFeedPrices = async (
  _chainId: string,
  config: ChainlinkChainConfig,
): Promise<Record<string, ChainlinkPriceObservation>> =>
  Object.fromEntries(
    config.feeds.map((feed) => [
      feed.tokenAddress,
      {
        usdPrice: feedAnswers[feed.feedAddress.toLowerCase()],
        timestamp: round,
      },
    ]),
  );

function collidingJob(references: { token_address: string; value: number }[]) {
  return chainlinkPriceFetcher({
    sql: stubSql(references),
    chainId: 42161n,
    intervalMs: 60_000,
    config: {
      rpcUrls: ["https://rpc.invalid"],
      catalogUrl: "https://catalog.invalid/feeds.json",
      feeds: [
        {
          tokenAddress: configured,
          feedAddress: "0x00000000000000000000000000000000000000f4",
          maxAgeSeconds: 3600,
        },
      ],
    },
    catalogRefreshIntervalMs: 3_600_000,
    catalogCache: () => Effect.succeed(catalog),
    readFeedPrices,
  });
}

async function poll(job: ReturnType<typeof chainlinkPriceFetcher>) {
  const logs: string[] = [];
  const collector = Logger.make(({ message }) => {
    logs.push((Array.isArray(message) ? message : [message]).join(" "));
  });
  const batches = await Effect.runPromise(
    Stream.runCollect(job.fetch).pipe(
      Effect.provide(Logger.layer([collector])),
    ),
  );
  const updated = [...batches]
    .flat()
    .map(({ tokenAddress }) => tokenAddress)
    .sort();
  return { updated, logs };
}

const referencePrices = [
  // Off by 100x: the AAA feed is pricing some other asset.
  { token_address: "161", value: 1 },
  // Within a few percent.
  { token_address: "162", value: 101 },
  // CCC has no other price at all.
  // The configured feed disagrees too, and is kept regardless.
  { token_address: "164", value: 1 },
];

test("a discovered feed that disagrees with its token's other prices is withheld", async () => {
  const { updated, logs } = await poll(collidingJob(referencePrices));

  // AAA (0xa1) is withheld; the agreeing, the unchecked and the configured
  // feed all report.
  expect(updated).toEqual(["0xa2", "0xa3", "0xa4"]);
  expect(logs).toContain(
    `Chainlink on chain 42161 withholds 1 discovered feeds that disagree with every other price for their token: ${collides}`,
  );
});

test("discovered feeds with no other price are named once, when the set changes", async () => {
  const job = collidingJob(referencePrices);
  const unchecked = `Chainlink on chain 42161 cannot check 1 discovered feeds, which have no other current price for their token: ${unpriced}`;

  const first = await poll(job);
  expect(first.logs).toContain(unchecked);
  // Only CCC: an agreeing or a withheld feed was checked, and the configured
  // feed is not the guard's to check.
  expect(first.logs.join("\n")).not.toContain(agrees);

  // The same set on the next poll says nothing.
  const second = await poll(job);
  expect(second.logs.filter((line) => line.includes("cannot check"))).toEqual(
    [],
  );
  expect(second.logs.filter((line) => line.includes("withholds"))).toEqual([]);
});

test("a feed that leaves the unchecked set and returns is not named again", async () => {
  const references = [...referencePrices];
  const job = collidingJob(references);
  const uncheckedLines = async () =>
    (await poll(job)).logs.filter((line) => line.includes("cannot check"));

  expect(await uncheckedLines()).toEqual([
    `Chainlink on chain 42161 cannot check 1 discovered feeds, which have no other current price for their token: ${unpriced}`,
  ]);

  // CCC gains another price, then loses it again, as sUSDai does on Ethereum
  // when Sushi drops it from its price list for a few minutes.
  references.push({ token_address: "163", value: 100 });
  expect(await uncheckedLines()).toEqual([]);
  references.pop();
  expect(await uncheckedLines()).toEqual([]);

  // BBB has never been unchecked, so losing its only price is news.
  references.splice(
    references.findIndex((row) => row.token_address === "162"),
    1,
  );
  expect(await uncheckedLines()).toEqual([
    `Chainlink on chain 42161 cannot check 2 discovered feeds, which have no other current price for their token: ${agrees}, ${unpriced} (new: ${agrees})`,
  ]);
});
