import { afterEach, expect, test } from "bun:test";
import { Duration, Effect, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { Sql } from "postgres";
import {
  checkCoinGeckoCredits,
  COINGECKO_REOPEN_MIN_REMAINING,
  coingeckoNativePriceFetcher,
  coingeckoPriceFetcher,
} from "./coingecko";
import {
  COINGECKO_QUOTA_PAUSE_MS,
  makeCoinGeckoQuotaGate,
} from "./coingeckoQuota";
import type { PriceFetcher, PriceUpdate } from "./types";

const realFetch = globalThis.fetch;

const apiKey = "test-key";

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubCoinGecko(reply: (url: URL) => unknown): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    return new Response(JSON.stringify(reply(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return requested;
}

function toRows(addresses: readonly string[]) {
  return addresses.map((address) => ({
    token_address: BigInt(address).toString(),
  }));
}

function stubSql(
  addresses: () => readonly string[],
  retainedPrices: readonly string[] = [],
): Sql<{ bigint: bigint }> {
  return ((strings: TemplateStringsArray) =>
    Promise.resolve(
      toRows(
        strings.join("").includes("erc20_tokens_latest_price_by_source")
          ? retainedPrices
          : addresses(),
      ),
    )) as unknown as Sql<{ bigint: bigint }>;
}

async function collect(fetch: PriceFetcher, atMs = 0): Promise<PriceUpdate[]> {
  const batches = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.millis(atMs));
      return yield* Stream.runCollect(fetch);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  return batches.flatMap((batch) => [...batch]);
}

test("the native fetcher prices every chain sharing a coin ID in one request", async () => {
  const requested = stubCoinGecko(() => ({ ethereum: { usd: 3_000 } }));
  const job = coingeckoNativePriceFetcher({
    intervalMs: 900_000,
    chainIdsByCoinId: { ethereum: [1n, 8453n, 4663n, 42161n] },
    apiKey,
  });

  const updates = await collect(job.fetch);

  expect(requested).toHaveLength(1);
  expect(requested[0]).toContain("ids=ethereum");
  expect(updates.map((update) => update.chainId)).toEqual([
    1n,
    8453n,
    4663n,
    42161n,
  ]);
  expect(new Set(updates.map((update) => update.usdPrice))).toEqual(
    new Set([3_000]),
  );
  expect(job.chainIds).toEqual([1n, 8453n, 4663n, 42161n]);
});

test("the native fetcher issues one request per distinct coin ID", async () => {
  const requested = stubCoinGecko(() => ({
    ethereum: { usd: 3_000 },
    binancecoin: { usd: 600 },
  }));
  const job = coingeckoNativePriceFetcher({
    intervalMs: 900_000,
    chainIdsByCoinId: { ethereum: [1n, 8453n], binancecoin: [56n] },
    apiKey,
  });

  const updates = await collect(job.fetch);

  expect(requested).toHaveLength(1);
  expect(updates).toHaveLength(3);
  expect(updates.find((update) => update.chainId === 56n)?.usdPrice).toBe(600);
});

test("the native fetcher skips chains CoinGecko did not price", async () => {
  stubCoinGecko(() => ({ ethereum: { usd: 0 } }));
  const job = coingeckoNativePriceFetcher({
    intervalMs: 900_000,
    chainIdsByCoinId: { ethereum: [1n, 8453n] },
    apiKey,
  });

  expect(await collect(job.fetch)).toEqual([]);
});

const TOKENS = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
  "0x4444444444444444444444444444444444444444",
];

function requestedAddresses(requested: string[]): string[][] {
  return requested.map((url) =>
    (new URL(url).searchParams.get("contract_addresses") ?? "").split(","),
  );
}

test("the token fetcher sweeps every address on its first cycle", async () => {
  const requested = stubCoinGecko(() => ({ [TOKENS[0]]: { usd: 1 } }));
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => TOKENS),
    chainId: 8453n,
    intervalMs: 900_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch);

  expect(requestedAddresses(requested)).toEqual([TOKENS]);
});

test("the token fetcher drops addresses CoinGecko does not price from later cycles", async () => {
  const requested = stubCoinGecko(() => ({
    [TOKENS[0]]: { usd: 1 },
    [TOKENS[1]]: { usd: 2 },
  }));
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => TOKENS),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 1_000_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch, 0);
  requested.length = 0;
  const updates = await collect(job.fetch, 1_000);

  expect(requestedAddresses(requested)).toEqual([[TOKENS[0], TOKENS[1]]]);
  expect(updates.map((update) => update.usdPrice)).toEqual([1, 2]);
});

test("the token fetcher re-probes unpriced addresses on rotation", async () => {
  const requested = stubCoinGecko(() => ({}));
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => TOKENS),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 2_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch, 0);
  requested.length = 0;
  await collect(job.fetch, 1_000);
  await collect(job.fetch, 2_000);

  expect(requestedAddresses(requested)).toEqual([
    [TOKENS[1], TOKENS[3]],
    [TOKENS[0], TOKENS[2]],
  ]);
});

test("the token fetcher picks up a token that CoinGecko lists later", async () => {
  let listed = false;
  const requested = stubCoinGecko(() =>
    listed ? { [TOKENS[1]]: { usd: 5 } } : {},
  );
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => TOKENS),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 2_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch, 0);
  listed = true;
  await collect(job.fetch, 1_000);
  requested.length = 0;
  await collect(job.fetch, 2_000);

  expect(requestedAddresses(requested)[0]).toContain(TOKENS[1]);
});

test("the token fetcher forgets addresses that leave erc20_tokens", async () => {
  const requested = stubCoinGecko(() => ({ [TOKENS[0]]: { usd: 1 } }));
  let addresses = TOKENS;
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => addresses),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 1_000_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch, 0);
  addresses = TOKENS.slice(1);
  requested.length = 0;
  await collect(job.fetch, 1_000);

  expect(requestedAddresses(requested).flat()).not.toContain(TOKENS[0]);
});

test("a restart seeds the rotation from retained cg1 prices instead of sweeping", async () => {
  const requested = stubCoinGecko(() => ({ [TOKENS[2]]: { usd: 3 } }));
  let addresses: readonly string[] = TOKENS;
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => addresses, [TOKENS[2]]),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 1_000_000,
    platform: "base",
    apiKey,
  });

  const updates = await collect(job.fetch, 5_000);

  expect(requestedAddresses(requested)).toEqual([[TOKENS[2]]]);
  expect(updates.map((update) => update.usdPrice)).toEqual([3]);

  const added = "0x5555555555555555555555555555555555555555";
  addresses = [...TOKENS, added];
  requested.length = 0;
  await collect(job.fetch, 6_000);

  expect(requestedAddresses(requested)).toEqual([[TOKENS[2], added]]);
});

test("a chain with no retained cg1 prices still sweeps on a cold start", async () => {
  const requested = stubCoinGecko(() => ({}));
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => TOKENS, []),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 1_000_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch, 5_000);

  expect(requestedAddresses(requested)).toEqual([TOKENS]);
});

test("the token fetcher passes a minimum visibility priority to its table read", async () => {
  stubCoinGecko(() => ({}));
  const tokenReads: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("");
    if (!text.includes("erc20_tokens_latest_price_by_source")) {
      tokenReads.push(values);
    }
    return Promise.resolve(toRows(TOKENS));
  }) as unknown as Sql<{ bigint: bigint }>;

  const restricted = coingeckoPriceFetcher({
    sql,
    chainId: 1n,
    intervalMs: 1_000,
    platform: "ethereum",
    apiKey,
    minVisibilityPriority: 1,
  });
  await collect(restricted.fetch);

  const unrestricted = coingeckoPriceFetcher({
    sql,
    chainId: 8453n,
    intervalMs: 1_000,
    platform: "base",
    apiKey,
  });
  await collect(unrestricted.fetch);

  expect(tokenReads).toEqual([
    [1n, 1, 1, false],
    [8453n, null, null, false],
  ]);
});

test("the token fetcher pads Starknet addresses to 64 hex digits", async () => {
  const short =
    "0x36834a40984312f7f7de8d31e3f6305b325389eaeea5b1c0664b2fb936461a4";
  const padded =
    "0x036834a40984312f7f7de8d31e3f6305b325389eaeea5b1c0664b2fb936461a4";
  const other =
    "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
  const requested = stubCoinGecko(() => ({
    [`0x${short.slice(2).toUpperCase()}`]: { usd: 60_000 },
  }));
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => [other, short]),
    chainId: 23448594291968334n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 1_000_000,
    platform: "starknet",
    apiKey,
    addressHexDigits: 64,
  });

  const updates = await collect(job.fetch, 0);
  expect(requestedAddresses(requested)).toEqual([[other, padded]]);
  expect(
    updates.map((update) => [update.tokenAddress, update.usdPrice]),
  ).toEqual([[short, 60_000]]);

  requested.length = 0;
  await collect(job.fetch, 1_000);
  expect(requestedAddresses(requested)).toEqual([[padded]]);
});

const QUOTA_BODY = JSON.stringify({
  status: {
    error_code: 10006,
    error_message:
      "You have reached your account's monthly credit limit. Overage is disabled.",
  },
});

function stubQuota(
  exhausted: () => boolean,
  reply: (url: URL) => unknown,
  body = QUOTA_BODY,
): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    return exhausted()
      ? new Response(body, { status: 429, statusText: "Too Many Requests" })
      : new Response(JSON.stringify(reply(url)), { status: 200 });
  }) as typeof globalThis.fetch;
  return requested;
}

test("a monthly quota refusal pauses every CoinGecko job sharing the gate", async () => {
  let exhausted = true;
  const requested = stubQuota(
    () => exhausted,
    (url) =>
      url.pathname.endsWith("/simple/price")
        ? { ethereum: { usd: 3_000 } }
        : { [TOKENS[0]]: { usd: 1 } },
  );
  const quotaGate = makeCoinGeckoQuotaGate();
  const tokens = coingeckoPriceFetcher({
    sql: stubSql(() => TOKENS),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 1_000_000,
    platform: "base",
    apiKey,
    quotaGate,
  });
  const native = coingeckoNativePriceFetcher({
    intervalMs: 1_000,
    chainIdsByCoinId: { ethereum: [8453n] },
    apiKey,
    quotaGate,
  });

  expect(await collect(tokens.fetch, 0)).toEqual([]);
  expect(requested).toHaveLength(1);

  expect(await collect(native.fetch, 1_000)).toEqual([]);
  expect(await collect(tokens.fetch, COINGECKO_QUOTA_PAUSE_MS - 1)).toEqual([]);
  expect(requested).toHaveLength(1);

  exhausted = false;
  requested.length = 0;
  const updates = await collect(tokens.fetch, COINGECKO_QUOTA_PAUSE_MS);
  expect(requestedAddresses(requested)).toEqual([TOKENS]);
  expect(updates.map((update) => update.usdPrice)).toEqual([1]);
  expect(
    (await collect(native.fetch, COINGECKO_QUOTA_PAUSE_MS)).map(
      (update) => update.usdPrice,
    ),
  ).toEqual([3_000]);
});

test("reopening the gate ends a quota pause early", async () => {
  let exhausted = true;
  const requested = stubQuota(
    () => exhausted,
    () => ({}),
  );
  const quotaGate = makeCoinGeckoQuotaGate();
  const job = coingeckoNativePriceFetcher({
    intervalMs: 1_000,
    chainIdsByCoinId: { ethereum: [8453n] },
    apiKey,
    quotaGate,
  });

  await collect(job.fetch, 0);
  exhausted = false;
  await Effect.runPromise(
    quotaGate.reopen("test").pipe(Effect.provide(TestClock.layer())),
  );
  await collect(job.fetch, 1_000);

  expect(requested).toHaveLength(2);
});

test("a per-minute rate limit fails the cycle without pausing", async () => {
  const requested = stubQuota(
    () => true,
    () => ({}),
    JSON.stringify({ status: { error_code: 429, error_message: "Throttled" } }),
  );
  const quotaGate = makeCoinGeckoQuotaGate();
  const job = coingeckoNativePriceFetcher({
    intervalMs: 1_000,
    chainIdsByCoinId: { ethereum: [8453n] },
    apiKey,
    quotaGate,
  });

  await expect(collect(job.fetch, 0)).rejects.toThrow(/429/);
  await expect(collect(job.fetch, 1_000)).rejects.toThrow(/429/);
  expect(requested).toHaveLength(2);
});

test("the credit check reads GET /key and reopens a paused gate once credits return", async () => {
  let exhausted = true;
  const requested = stubQuota(
    () => exhausted,
    (url) =>
      url.pathname.endsWith("/key")
        ? {
            plan: "Analyst",
            monthly_call_credit: 500_000,
            current_total_monthly_calls: 12,
            current_remaining_monthly_calls: 499_988,
          }
        : { ethereum: { usd: 3_000 } },
  );
  const quotaGate = makeCoinGeckoQuotaGate();
  const job = coingeckoNativePriceFetcher({
    intervalMs: 1_000,
    chainIdsByCoinId: { ethereum: [8453n] },
    apiKey,
    quotaGate,
  });

  await collect(job.fetch, 0);
  exhausted = false;
  await Effect.runPromise(
    checkCoinGeckoCredits({ apiKey, quotaGate }).pipe(
      Effect.provide(TestClock.layer()),
    ),
  );
  const updates = await collect(job.fetch, 1_000);

  expect(requested.map((url) => new URL(url).pathname)).toEqual([
    "/api/v3/simple/price",
    "/api/v3/key",
    "/api/v3/simple/price",
  ]);
  expect(updates.map((update) => update.usdPrice)).toEqual([3_000]);
});

test("re-probe slots neither repeat nor skip when launches drift across epochs", async () => {
  const requested = stubCoinGecko(() => ({}));
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => TOKENS),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 4_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch, 0);
  requested.length = 0;
  await collect(job.fetch, 1_000);
  await collect(job.fetch, 1_999);
  await collect(job.fetch, 3_500);

  expect(requestedAddresses(requested)).toEqual([
    [TOKENS[1]],
    [TOKENS[2], TOKENS[3]],
  ]);
});

test("the credit check keeps the gate closed until a margin of credits is back", async () => {
  let remaining = 500;
  let exhausted = true;
  const requested = stubQuota(
    () => exhausted,
    (url) =>
      url.pathname.endsWith("/key")
        ? {
            plan: "Analyst",
            monthly_call_credit: 500_000,
            current_total_monthly_calls: 500_000 - remaining,
            current_remaining_monthly_calls: remaining,
          }
        : { ethereum: { usd: 3_000 } },
  );
  const quotaGate = makeCoinGeckoQuotaGate();
  const job = coingeckoNativePriceFetcher({
    intervalMs: 1_000,
    chainIdsByCoinId: { ethereum: [8453n] },
    apiKey,
    quotaGate,
  });
  const check = () =>
    Effect.runPromise(
      checkCoinGeckoCredits({ apiKey, quotaGate }).pipe(
        Effect.provide(TestClock.layer()),
      ),
    );

  await collect(job.fetch, 0);
  exhausted = false;
  await check();
  await collect(job.fetch, 1_000);
  remaining = COINGECKO_REOPEN_MIN_REMAINING;
  await check();
  await collect(job.fetch, 2_000);

  expect(requested.map((url) => new URL(url).pathname)).toEqual([
    "/api/v3/simple/price",
    "/api/v3/key",
    "/api/v3/key",
    "/api/v3/simple/price",
  ]);
});

test("a failed cycle leaves its re-probe slot due for the next one", async () => {
  let failing = false;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    requested.push(String(input));
    return failing
      ? new Response("upstream down", {
          status: 500,
          statusText: "Internal Server Error",
        })
      : new Response(JSON.stringify({}), { status: 200 });
  }) as typeof globalThis.fetch;
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => TOKENS),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 4_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch, 0);
  failing = true;
  await expect(collect(job.fetch, 1_000)).rejects.toThrow(/500/);
  failing = false;
  requested.length = 0;
  await collect(job.fetch, 2_000);

  expect(requestedAddresses(requested)).toEqual([[TOKENS[1], TOKENS[2]]]);
});
