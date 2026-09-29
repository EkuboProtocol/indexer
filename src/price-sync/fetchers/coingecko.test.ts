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

// Records every URL requested and replies with the caller's payload.
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

// `sql` is only ever used here as a tagged template returning token rows: the
// indexed tokens, or the retained `cg1` observations the rotation seeds from.
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

// Runs one cycle with the clock at `atMs`, which fixes the rotation slot and
// whether a quota pause has elapsed.
async function collect(
  fetch: PriceFetcher,
  atMs = 0,
): Promise<PriceUpdate[]> {
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
  // Only the first two tokens are listed; the rest should fall out of rotation.
  const requested = stubCoinGecko(() => ({
    [TOKENS[0]]: { usd: 1 },
    [TOKENS[1]]: { usd: 2 },
  }));
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => TOKENS),
    chainId: 8453n,
    intervalMs: 1_000,
    // Long enough that no unpriced token is due again during this test.
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
    // Two slots: half the unpriced tail comes due on each cycle.
    unpricedReprobeIntervalMs: 2_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch, 0);
  requested.length = 0;
  await collect(job.fetch, 1_000);
  await collect(job.fetch, 2_000);

  // The slot follows the clock: t=1s is slot 1 (indexes 1 and 3), t=2s is
  // slot 0 (0 and 2).
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
  await collect(job.fetch, 1_000); // slot 1 re-probes TOKENS[1] and finds a price
  requested.length = 0;
  await collect(job.fetch, 2_000);

  // Now priced, TOKENS[1] is requested every cycle rather than on rotation.
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

  // TOKENS[0] was the only priced address, so dropping it from erc20_tokens
  // must drop it from the fast lane too rather than pinning it there forever.
  expect(requestedAddresses(requested).flat()).not.toContain(TOKENS[0]);
});

test("a restart seeds the rotation from retained cg1 prices instead of sweeping", async () => {
  const requested = stubCoinGecko(() => ({ [TOKENS[2]]: { usd: 3 } }));
  let addresses: readonly string[] = TOKENS;
  // A fresh fetcher is what a restarted process has: nothing in memory.
  const job = coingeckoPriceFetcher({
    sql: stubSql(() => addresses, [TOKENS[2]]),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 1_000_000,
    platform: "base",
    apiKey,
  });

  // t=5s is slot 5, which no token index hits: only the seeded priced token.
  const updates = await collect(job.fetch, 5_000);

  expect(requestedAddresses(requested)).toEqual([[TOKENS[2]]]);
  expect(updates.map((update) => update.usdPrice)).toEqual([3]);

  // A token that enters the table after startup is still discovered at once.
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

const QUOTA_BODY = JSON.stringify({
  status: {
    error_code: 10006,
    error_message:
      "You have reached your account's monthly credit limit. Overage is disabled.",
  },
});

// Replies 429 with CoinGecko's monthly-limit body while `exhausted()` holds.
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

  // The refusal is absorbed rather than failing the cycle...
  expect(await collect(tokens.fetch, 0)).toEqual([]);
  expect(requested).toHaveLength(1);

  // ...and no job asks again while the pause lasts.
  expect(await collect(native.fetch, 1_000)).toEqual([]);
  expect(await collect(tokens.fetch, COINGECKO_QUOTA_PAUSE_MS - 1)).toEqual([]);
  expect(requested).toHaveLength(1);

  // Once it lapses they resume, and the refused batch was not recorded as
  // "unpriced": every token is still swept.
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
  const requested = stubQuota(() => exhausted, () => ({}));
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

  await collect(job.fetch, 0); // trips the gate
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
    // Four slots: one token index apiece.
    unpricedReprobeIntervalMs: 4_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch, 0); // cold sweep, epoch 0
  requested.length = 0;
  await collect(job.fetch, 1_000); // epoch 1: slot 1
  await collect(job.fetch, 1_999); // epoch 1 again: nothing due
  await collect(job.fetch, 3_500); // jumped to epoch 3: slots 2 and 3

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

  await collect(job.fetch, 0); // trips the gate
  exhausted = false;
  await check(); // 500 left: below the margin, stays paused
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
