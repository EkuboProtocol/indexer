import { expect, test } from "bun:test";
import type { PriceSyncJob, PriceUpdate } from "./fetchers/types";
import { runPriceSyncJob } from "./runPriceSyncJob";

test("runPriceSyncJob writes each yielded batch and reports totals", async () => {
  const timestamp = new Date("2026-07-28T12:00:00.000Z");
  const batches: PriceUpdate[][] = [
    [
      {
        chainId: 1n,
        tokenAddress: "0x0",
        timestamp,
        usdPrice: 3_000,
      },
    ],
    [
      {
        chainId: 1n,
        tokenAddress: "0x1",
        timestamp,
        usdPrice: 1,
      },
      {
        chainId: 1n,
        tokenAddress: "0x2",
        timestamp,
        usdPrice: 2,
      },
    ],
  ];
  const job: PriceSyncJob = {
    chainIds: [1n],
    source: "tst",
    intervalMs: 1_000,
    fetch: async function* () {
      yield batches[0];
      yield [];
      yield batches[1];
    },
  };
  const writes: { source: string; updates: readonly PriceUpdate[] }[] = [];

  const result = await runPriceSyncJob(job, async (source, updates) => {
    writes.push({ source, updates });
    return updates.length - 1;
  });

  expect(writes).toEqual([
    { source: "tst", updates: batches[0] },
    { source: "tst", updates: batches[1] },
  ]);
  expect(result).toEqual({
    batchCount: 2,
    updateCount: 3,
    insertedCount: 1,
  });
});

test("runPriceSyncJob rejects updates for a different chain", async () => {
  const priceJob: PriceSyncJob = {
    chainIds: [1n],
    source: "tst",
    intervalMs: 1_000,
    fetch: async function* () {
      yield [
        {
          chainId: 8453n,
          tokenAddress: "0x1",
          timestamp: new Date("2026-07-28T12:00:00.000Z"),
          usdPrice: 1,
        },
      ];
    },
  };

  await expect(runPriceSyncJob(priceJob, async () => 1)).rejects.toThrow(
    "Price sync job 1:tst yielded an update for chain 8453",
  );
});

test("runPriceSyncJob accepts every chain a multi-chain job declares", async () => {
  const timestamp = new Date("2026-07-28T12:00:00.000Z");
  const priceJob: PriceSyncJob = {
    chainIds: [1n, 8453n],
    source: "tst",
    intervalMs: 1_000,
    fetch: async function* () {
      yield [{ chainId: 1n, tokenAddress: "0x0", timestamp, usdPrice: 3_000 }];
      yield [
        { chainId: 8453n, tokenAddress: "0x0", timestamp, usdPrice: 3_000 },
      ];
    },
  };

  const result = await runPriceSyncJob(priceJob, async () => 1);

  expect(result).toEqual({ batchCount: 2, updateCount: 2, insertedCount: 2 });
});
