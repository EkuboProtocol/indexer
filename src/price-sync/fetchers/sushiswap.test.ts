import { afterEach, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { PriceSyncError } from "../errors";
import { sushiswapPriceFetcher } from "./sushiswap";
import type { PriceUpdate } from "./types";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function stubSushi(reply: () => unknown, status = 200): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    requested.push(String(input));
    const body = reply();
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return requested;
}

function collect(
  chainId: bigint,
  wrappedNative?: `0x${string}`,
): Promise<PriceUpdate[]> {
  const job = sushiswapPriceFetcher({ chainId, intervalMs: 60_000, wrappedNative });
  return Effect.runPromise(Stream.runCollect(job.fetch)).then((batches) =>
    batches.flatMap((batch) => [...batch]),
  );
}

test("the fetcher prices the chain it was configured for", async () => {
  const requested = stubSushi(() => ({ [USDC]: 1 }));

  const updates = await collect(8453n);

  expect(requested).toEqual(["https://api.sushi.com/price/v1/8453"]);
  expect(updates).toEqual([
    {
      chainId: 8453n,
      tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      timestamp: expect.any(Date),
      usdPrice: 1,
    },
  ]);
});

test("the native currency is rekeyed onto 0x0", async () => {
  // Sushi reports the native currency under a sentinel address; the database
  // keys it as 0x0, and the interface reads it there.
  stubSushi(() => ({ [NATIVE_SENTINEL]: 3_000, [USDC]: 1 }));

  const updates = await collect(1n);
  const byAddress = Object.fromEntries(
    updates.map((update) => [update.tokenAddress, update.usdPrice]),
  );

  expect(byAddress["0x0"]).toBe(3_000);
  expect(byAddress[NATIVE_SENTINEL]).toBeUndefined();
  expect(Object.keys(byAddress)).toHaveLength(2);
});

// Checksummed, as jobs.ts writes it; Sushi keys the list in lower case.
const WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d";

function pricesByAddress(updates: PriceUpdate[]): Record<string, number> {
  return Object.fromEntries(
    updates.map((update) => [update.tokenAddress, update.usdPrice]),
  );
}

test("without a sentinel, the wrapped native token prices 0x0", async () => {
  // Gnosis, Monad and MegaETH list only the wrapped token.
  stubSushi(() => ({ [WXDAI.toLowerCase()]: 0.9995, [USDC]: 1 }));

  const byAddress = pricesByAddress(await collect(100n, WXDAI));

  expect(byAddress["0x0"]).toBe(0.9995);
  // The wrapped token keeps its own price under its own address.
  expect(byAddress[WXDAI.toLowerCase()]).toBe(0.9995);
  expect(Object.keys(byAddress)).toHaveLength(3);
});

test("a sentinel price wins over the wrapped native token", async () => {
  stubSushi(() => ({ [NATIVE_SENTINEL]: 1.001, [WXDAI.toLowerCase()]: 0.9995 }));

  const byAddress = pricesByAddress(await collect(100n, WXDAI));

  expect(byAddress["0x0"]).toBe(1.001);
});

test("without a configured wrapper, a missing sentinel leaves 0x0 unpriced", async () => {
  stubSushi(() => ({ [WXDAI.toLowerCase()]: 0.9995 }));

  const byAddress = pricesByAddress(await collect(100n));

  expect(byAddress["0x0"]).toBeUndefined();
});

test("a configured wrapper Sushi does not list leaves 0x0 unpriced", async () => {
  stubSushi(() => ({ [USDC]: 1 }));

  const byAddress = pricesByAddress(await collect(100n, WXDAI));

  expect(byAddress["0x0"]).toBeUndefined();
});

test("an empty price list yields no batches at all", async () => {
  // An empty batch would otherwise be counted as a cycle that wrote nothing.
  stubSushi(() => ({}));

  const job = sushiswapPriceFetcher({ chainId: 1n, intervalMs: 60_000 });
  const batches = await Effect.runPromise(Stream.runCollect(job.fetch));

  expect(batches).toEqual([]);
});

test("an upstream failure names the chain that failed", async () => {
  stubSushi(() => "gateway timeout", 504);

  const error = await Effect.runPromise(
    Stream.runCollect(
      sushiswapPriceFetcher({ chainId: 42161n, intervalMs: 60_000 }).fetch,
    ).pipe(Effect.catch((caught) => Effect.succeed(caught))),
  );

  expect(error).toBeInstanceOf(PriceSyncError);
  expect((error as PriceSyncError).message).toContain("prices for chain 42161");
  expect((error as PriceSyncError).message).toContain("504");
});

test("the job declares the source and chain it writes under", async () => {
  const job = sushiswapPriceFetcher({ chainId: 4663n, intervalMs: 60_000 });

  expect(job.source).toBe("ss1");
  expect(job.chainIds).toEqual([4663n]);
});
