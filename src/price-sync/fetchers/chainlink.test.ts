import { expect, test } from "bun:test";
import type { Sql } from "postgres";
import { chainlinkPriceFetcher } from "./chainlink";

const tokenAddress = "0x0000000000000000000000000000000000000001";
const feedAddress = "0x0000000000000000000000000000000000000002";

// The generator queries indexed tokens before reaching the catalog; returning
// an empty set is enough for discovery to have nothing to add.
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
  });

  // Discovery must be swallowed, leaving the configured feed to be read. The
  // read itself then fails on the unroutable RPC — a distinct failure, which
  // is what proves the override survived the catalog outage.
  let reachedFeedRead = false;
  try {
    for await (const _ of job.fetch()) {
      // no-op: the RPC read throws before any batch is yielded
    }
  } catch (error) {
    reachedFeedRead = !/catalog/i.test(String(error));
  }

  expect(reachedFeedRead).toBe(true);
});

test("a chain with no configured feeds and no catalog yields nothing", async () => {
  const job = chainlinkPriceFetcher({
    sql,
    chainId: 1n,
    intervalMs: 60_000,
    config: { rpcUrls: ["https://rpc.invalid"], feeds: [] },
    catalogRefreshIntervalMs: 3_600_000,
  });

  const batches = [];
  for await (const batch of job.fetch()) batches.push(batch);
  expect(batches).toEqual([]);
});
