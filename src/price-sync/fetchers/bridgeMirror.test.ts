import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import type { Sql } from "postgres";
import { bridgeMirrorPriceFetcher } from "./bridgeMirror";

function fakeSql(rows: unknown[]): Sql<{ bigint: bigint }> {
  return (async () => rows) as unknown as Sql<{ bigint: bigint }>;
}

const inOneMinute = () => new Date(Date.now() + 60_000);

function collect(rows: unknown[]) {
  const job = bridgeMirrorPriceFetcher({
    sql: fakeSql(rows),
    chainIds: [130n, 42161n],
    intervalMs: 60_000,
  });
  return Effect.runPromise(Stream.runCollect(job.fetch));
}

test("mirrored prices are batched per chain and keep the copied validity", async () => {
  const validUntil = inOneMinute();
  const batches = await collect([
    {
      chain_id: 130n,
      token_address: "171",
      value: 120,
      valid_until: validUntil,
    },
    {
      chain_id: 42161n,
      token_address: "255",
      value: 3,
      valid_until: validUntil,
    },
    {
      chain_id: 130n,
      token_address: "4095",
      value: 0.5,
      valid_until: validUntil,
    },
  ]);

  expect(
    batches.map((batch) =>
      batch.map((update) => [
        update.chainId,
        update.tokenAddress,
        update.usdPrice,
      ]),
    ),
  ).toEqual([
    [
      [130n, "0xab", 120],
      [130n, "0xfff", 0.5],
    ],
    [[42161n, "0xff", 3]],
  ]);
  for (const update of batches.flat()) {
    expect(update.validUntil).toEqual(validUntil);
  }
});

test("rows expired by the worker's clock or without a usable price are dropped", async () => {
  const batches = await collect([
    {
      chain_id: 130n,
      token_address: "1",
      value: 1,
      valid_until: new Date(Date.now() - 1),
    },
    {
      chain_id: 130n,
      token_address: "2",
      value: 0,
      valid_until: inOneMinute(),
    },
    {
      chain_id: 130n,
      token_address: "3",
      value: Number.NaN,
      valid_until: inOneMinute(),
    },
  ]);

  expect(batches).toEqual([]);
});

test("the job declares its source and chains", () => {
  const job = bridgeMirrorPriceFetcher({
    sql: fakeSql([]),
    chainIds: [130n, 42161n],
    intervalMs: 60_000,
  });

  expect(job.source).toBe("bm1");
  expect(job.chainIds).toEqual([130n, 42161n]);
});
