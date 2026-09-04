import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Exit } from "effect";
import { loadPriceSyncConfig } from "./config";

const PG = "postgresql://user@localhost:5432/indexer";

function load(env: Record<string, string>) {
  return Effect.runPromise(
    Effect.provideService(
      loadPriceSyncConfig(),
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({ PG_CONNECTION_STRING: PG, ...env }),
    ),
  );
}

function loadExit(env: Record<string, string>) {
  return Effect.runPromiseExit(
    Effect.provideService(
      loadPriceSyncConfig(),
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord(env),
    ),
  );
}

test("an empty environment gets the documented defaults", async () => {
  const config = await load({});

  expect(config).toEqual({
    pgConnectionString: PG,
    defaultIntervalMs: 60_000,
    // Both optional sources are off unless an interval is set for them.
    coingeckoIntervalMs: 0,
    chainlinkIntervalMs: 0,
    chainlinkConfig: {},
    chainlinkCatalogRefreshIntervalMs: 3_600_000,
    coingeckoApiKey: undefined,
    quoterBaseUrl: "https://prod-api-quoter.ekubo.org",
    quoterMinTimeMs: 1_000,
  });
});

test("interval settings are converted from seconds to milliseconds", async () => {
  const config = await load({
    TOKEN_PRICE_SYNC_INTERVAL_MS: "30000",
    COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS: "300",
    CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS: "45",
  });

  expect(config.defaultIntervalMs).toBe(30_000);
  expect(config.coingeckoIntervalMs).toBe(300_000);
  expect(config.chainlinkIntervalMs).toBe(45_000);
});

test("a zero catalog refresh interval disables refreshing rather than crashing", async () => {
  // Zero disables, following the sibling *_SECONDS settings. Reading it as a
  // strictly positive value would turn an operator's deliberate disable into a
  // crash loop that takes every price source down, not just Chainlink.
  const config = await load({
    CHAINLINK_FEED_CATALOG_REFRESH_INTERVAL_SECONDS: "0",
  });

  expect(config.chainlinkCatalogRefreshIntervalMs).toBe(
    Number.POSITIVE_INFINITY,
  );
});

test("the quoter rate limit becomes a minimum spacing", async () => {
  const config = await load({ MAX_QUOTER_REQUESTS_PER_MINUTE: "120" });

  expect(config.quoterMinTimeMs).toBe(500);
});

test("a trailing slash on the quoter URL is trimmed", async () => {
  const config = await load({ EKUBO_QUOTER_URL: "https://quoter.example///" });

  expect(config.quoterBaseUrl).toBe("https://quoter.example");
});

test("an unset CoinGecko key is absent rather than empty", async () => {
  // The key is only required when CoinGecko syncing is actually enabled, so an
  // operator who never turned it on must still be able to start the worker.
  expect((await load({})).coingeckoApiKey).toBeUndefined();
  expect((await load({ COINGECKO_API_KEY: "" })).coingeckoApiKey).toBeUndefined();
  expect((await load({ COINGECKO_API_KEY: "k" })).coingeckoApiKey).toBe("k");
});

test("Chainlink feed configuration is parsed from JSON", async () => {
  const config = await load({
    CHAINLINK_TOKEN_PRICE_CONFIG: JSON.stringify({
      "1": {
        rpcUrls: ["https://eth.example"],
        catalogUrl: "https://catalog.example/feeds.json",
        feeds: [],
      },
    }),
  });

  expect(Object.keys(config.chainlinkConfig)).toEqual(["1"]);
});

const rejections: [name: string, env: Record<string, string>, message: string][] =
  [
    [
      "a non-positive sync interval",
      { TOKEN_PRICE_SYNC_INTERVAL_MS: "0" },
      "TOKEN_PRICE_SYNC_INTERVAL_MS must be a positive integer",
    ],
    [
      "a negative optional interval",
      { COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS: "-1" },
      "COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS must be a non-negative integer",
    ],
    [
      "a negative catalog refresh interval",
      { CHAINLINK_FEED_CATALOG_REFRESH_INTERVAL_SECONDS: "-5" },
      "CHAINLINK_FEED_CATALOG_REFRESH_INTERVAL_SECONDS must be a non-negative integer",
    ],
    [
      "a zero quoter rate limit",
      { MAX_QUOTER_REQUESTS_PER_MINUTE: "0" },
      "MAX_QUOTER_REQUESTS_PER_MINUTE must be a positive integer",
    ],
    [
      "malformed Chainlink configuration",
      { CHAINLINK_TOKEN_PRICE_CONFIG: "{not json" },
      "CHAINLINK_TOKEN_PRICE_CONFIG must be valid JSON",
    ],
  ];

for (const [name, env, message] of rejections) {
  test(`${name} is rejected at startup`, async () => {
    await expect(load(env)).rejects.toThrow(message);
  });
}

test("a missing connection string names the setting it could not read", async () => {
  // Previously this was `process.env.PG_CONNECTION_STRING!`, so an unset value
  // reached the driver as `undefined` instead of failing here.
  const exit = await loadExit({});

  expect(Exit.isFailure(exit)).toBe(true);
  expect(String(exit)).toContain("PG_CONNECTION_STRING");
});
