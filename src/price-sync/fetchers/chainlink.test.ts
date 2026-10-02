import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import type { Sql } from "postgres";
import {
  agreesWithReferencePrices,
  chainlinkPriceFetcher,
  makeChainlinkRoundTracker,
} from "./chainlink";
import { makeChainlinkCatalogCache } from "./chainlinkCatalog";

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
