import { afterEach, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import type { Sql } from "postgres";
import {
  coingeckoNativePriceFetcher,
  coingeckoPriceFetcher,
} from "./coingecko";
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

// `sql` is only ever used here as a tagged template returning token rows.
function stubSql(addresses: string[]): Sql<{ bigint: bigint }> {
  return (() =>
    Promise.resolve(
      addresses.map((address) => ({ token_address: BigInt(address).toString() })),
    )) as unknown as Sql<{ bigint: bigint }>;
}

async function collect(fetch: PriceFetcher): Promise<PriceUpdate[]> {
  const batches = await Effect.runPromise(Stream.runCollect(fetch));
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
    sql: stubSql(TOKENS),
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
    sql: stubSql(TOKENS),
    chainId: 8453n,
    intervalMs: 1_000,
    // Long enough that no unpriced token is due again during this test.
    unpricedReprobeIntervalMs: 1_000_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch);
  requested.length = 0;
  const updates = await collect(job.fetch);

  expect(requestedAddresses(requested)).toEqual([[TOKENS[0], TOKENS[1]]]);
  expect(updates.map((update) => update.usdPrice)).toEqual([1, 2]);
});

test("the token fetcher re-probes unpriced addresses on rotation", async () => {
  const requested = stubCoinGecko(() => ({}));
  const job = coingeckoPriceFetcher({
    sql: stubSql(TOKENS),
    chainId: 8453n,
    intervalMs: 1_000,
    // Two slots: half the unpriced tail comes due on each cycle.
    unpricedReprobeIntervalMs: 2_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch);
  requested.length = 0;
  await collect(job.fetch);
  await collect(job.fetch);

  // Cycle 2 takes slot 1 (indexes 1 and 3), cycle 3 takes slot 0 (0 and 2).
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
    sql: stubSql(TOKENS),
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 2_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch);
  listed = true;
  await collect(job.fetch); // slot 1 re-probes TOKENS[1] and finds a price
  requested.length = 0;
  await collect(job.fetch);

  // Now priced, TOKENS[1] is requested every cycle rather than on rotation.
  expect(requestedAddresses(requested)[0]).toContain(TOKENS[1]);
});

test("the token fetcher forgets addresses that leave erc20_tokens", async () => {
  const requested = stubCoinGecko(() => ({ [TOKENS[0]]: { usd: 1 } }));
  let addresses = TOKENS;
  const job = coingeckoPriceFetcher({
    sql: (() =>
      Promise.resolve(
        addresses.map((address) => ({
          token_address: BigInt(address).toString(),
        })),
      )) as unknown as Sql<{ bigint: bigint }>,
    chainId: 8453n,
    intervalMs: 1_000,
    unpricedReprobeIntervalMs: 1_000_000,
    platform: "base",
    apiKey,
  });

  await collect(job.fetch);
  addresses = TOKENS.slice(1);
  requested.length = 0;
  await collect(job.fetch);

  // TOKENS[0] was the only priced address, so dropping it from erc20_tokens
  // must drop it from the fast lane too rather than pinning it there forever.
  expect(requestedAddresses(requested).flat()).not.toContain(TOKENS[0]);
});
