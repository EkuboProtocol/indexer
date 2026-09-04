import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { Sql } from "postgres";
import { PriceSyncError } from "./errors";
import { defaultPriceValidityMs, type PriceUpdate } from "./fetchers/types";
import { persistPriceUpdates } from "./persistPriceUpdates";

const TIMESTAMP = new Date("2026-09-04T12:00:00.000Z");

function update(overrides: Partial<PriceUpdate> = {}): PriceUpdate {
  return {
    chainId: 1n,
    tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    timestamp: TIMESTAMP,
    usdPrice: 3_000,
    ...overrides,
  };
}

// Enough of the driver for the batch insert: a tagged template that reports a
// row count, which is also callable as the `sql(values)` helper.
function stubSql() {
  const inserted: unknown[][] = [];

  const tagged = (...args: unknown[]) => {
    // `sql(rows)` -- capture the values the query is being given.
    if (Array.isArray(args[0]) && !("raw" in (args[0] as object))) {
      inserted.push(args[0] as unknown[]);
      return args[0];
    }
    // sql`INSERT ...` -- the query itself.
    return Promise.resolve({ count: inserted.at(-1)?.length ?? 0 });
  };

  const sql = Object.assign(tagged, {
    begin: (cb: (tx: unknown) => unknown) => Promise.resolve(cb(sql)),
  }) as unknown as Sql<{ bigint: bigint }>;

  return { sql, inserted };
}

const run = (updates: readonly PriceUpdate[], validityMs = 60_000) => {
  const { sql, inserted } = stubSql();
  return Effect.runPromise(
    persistPriceUpdates(sql, "tst", updates, validityMs),
  ).then((count) => ({ count, rows: inserted.flat() as unknown[][] }));
};

const rejects = (updates: readonly PriceUpdate[]) => {
  const { sql } = stubSql();
  return Effect.runPromise(
    persistPriceUpdates(sql, "tst", updates, 60_000).pipe(
      Effect.catch((error) => Effect.succeed(error)),
    ),
  );
};

test("an empty batch writes nothing", async () => {
  const { count, rows } = await run([]);

  expect(count).toBe(0);
  expect(rows).toEqual([]);
});

test("a row carries the chain, address, source and price", async () => {
  const { count, rows } = await run([update()]);

  expect(count).toBe(1);
  expect(rows[0]).toEqual([
    "1",
    // The address is stored numerically, not as hex.
    BigInt("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48").toString(),
    TIMESTAMP.toISOString(),
    "tst",
    3_000,
    new Date(TIMESTAMP.getTime() + 60_000).toISOString(),
  ]);
});

test("validity is anchored at the observation, not at write time", async () => {
  // A source reporting an already-old measurement must not have its age
  // laundered away by being written now.
  const old = new Date(TIMESTAMP.getTime() - 3_600_000);
  const { rows } = await run([update({ timestamp: old })]);

  expect(rows[0][5]).toBe(new Date(old.getTime() + 60_000).toISOString());
});

test("a fetcher's own validity horizon wins over the job default", async () => {
  const validUntil = new Date(TIMESTAMP.getTime() + 86_400_000);
  const { rows } = await run([update({ validUntil })]);

  expect(rows[0][5]).toBe(validUntil.toISOString());
});

test("the default validity is three intervals, floored at a minute", async () => {
  expect(defaultPriceValidityMs(60_000)).toBe(180_000);
  expect(defaultPriceValidityMs(300_000)).toBe(900_000);
  // A deliberately aggressive development cadence still gets a usable horizon.
  expect(defaultPriceValidityMs(1_000)).toBe(60_000);
});

const invalid: [name: string, update: PriceUpdate][] = [
  ["a zero price", update({ usdPrice: 0 })],
  ["a negative price", update({ usdPrice: -1 })],
  ["a non-finite price", update({ usdPrice: Number.POSITIVE_INFINITY })],
  ["a NaN price", update({ usdPrice: Number.NaN })],
  ["an invalid timestamp", update({ timestamp: new Date("nonsense") })],
  [
    "a validity horizon at or before the observation",
    update({ validUntil: TIMESTAMP }),
  ],
];

for (const [name, bad] of invalid) {
  test(`${name} is rejected before anything is written`, async () => {
    const error = await rejects([bad]);

    expect(error).toBeInstanceOf(PriceSyncError);
  });
}

test("one bad row rejects its whole batch", async () => {
  // The insert is one transaction, so a batch either lands or does not; a row
  // that cannot be built must not leave a partial write behind.
  const error = await rejects([update(), update({ usdPrice: -1 }), update()]);

  expect(error).toBeInstanceOf(PriceSyncError);
});
