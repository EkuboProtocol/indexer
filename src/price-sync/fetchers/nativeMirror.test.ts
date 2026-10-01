import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import type { Sql } from "postgres";
import { nativeMirrorPriceFetcher } from "./nativeMirror";
import type { PriceUpdate } from "./types";

// Answers every query with `rows` and records the statement text, so a test
// can check what was asked as well as what came back.
function fakeSql(rows: unknown[]): {
  sql: Sql<{ bigint: bigint }>;
  statements: string[];
} {
  const statements: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return rows;
  }) as unknown as Sql<{ bigint: bigint }>;
  return { sql, statements };
}

function collect(sql: Sql<{ bigint: bigint }>): Promise<PriceUpdate[]> {
  const job = nativeMirrorPriceFetcher({
    sql,
    fromChainId: 1n,
    toChainIds: [130n, 480n],
    intervalMs: 60_000,
  });
  return Effect.runPromise(Stream.runCollect(job.fetch)).then((batches) =>
    batches.flatMap((batch) => [...batch]),
  );
}

const inOneMinute = () => new Date(Date.now() + 60_000);

test("the source chain's native price is copied to each mirrored chain", async () => {
  const validUntil = inOneMinute();
  const { sql } = fakeSql([{ source: "qp1", value: 2686.5, valid_until: validUntil }]);

  const before = Date.now();
  const updates = await collect(sql);

  expect(updates.map((update) => update.chainId)).toEqual([130n, 480n]);
  for (const update of updates) {
    expect(update.tokenAddress).toBe("0x0");
    expect(update.usdPrice).toBe(2686.5);
    // The copied validity is kept, so the mirror never outlives its source.
    expect(update.validUntil).toEqual(validUntil);
    // Stamped now, not with the source row's timestamp: re-copying an unchanged
    // row under its old timestamp would collide in the price history.
    expect(update.timestamp.getTime()).toBeGreaterThanOrEqual(before);
  }
});

test("CoinGecko rows are never mirrored", async () => {
  const { sql, statements } = fakeSql([]);

  await collect(sql);

  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain("source IN ('qp1', 'cl1', 'ss1')");
  expect(statements[0]).not.toMatch(/cg1|cgn/);
});

test("the pick is deterministic: confidence first, then source", async () => {
  const { sql, statements } = fakeSql([]);

  await collect(sql);

  expect(statements[0]).toMatch(/ORDER BY confidence DESC, source\s+LIMIT 1/);
});

test("no current source price yields no batches at all", async () => {
  const { sql } = fakeSql([]);

  expect(await collect(sql)).toEqual([]);
});

test("a row that expired between the query and the emit is skipped", async () => {
  // The query filters on the database clock; the worker's can be a little
  // ahead, and a validity that ends before the timestamp fails the batch.
  const { sql } = fakeSql([
    { source: "qp1", value: 2686.5, valid_until: new Date(Date.now() - 1) },
  ]);

  expect(await collect(sql)).toEqual([]);
});

test("a non-positive price is not mirrored", async () => {
  const { sql } = fakeSql([
    { source: "ss1", value: 0, valid_until: inOneMinute() },
  ]);

  expect(await collect(sql)).toEqual([]);
});

test("the job declares the source and the chains it writes under", () => {
  const job = nativeMirrorPriceFetcher({
    sql: fakeSql([]).sql,
    fromChainId: 1n,
    toChainIds: [130n, 480n, 57073n],
    intervalMs: 60_000,
  });

  expect(job.source).toBe("em1");
  expect(job.chainIds).toEqual([130n, 480n, 57073n]);
});
