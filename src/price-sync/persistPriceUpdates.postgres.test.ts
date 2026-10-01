import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Result } from "effect";
import postgres, { type Sql } from "postgres";
import shift from "postgres-shift";
import type { PriceUpdate } from "./fetchers/types";
import { persistPriceUpdates } from "./persistPriceUpdates";

// Concurrent persists need a real server: PGlite has a single connection, so
// it cannot hold two transactions' locks at once. CI provides one; locally,
// point this at any Postgres you can create databases on.
const SERVER = process.env.TEST_PG_CONNECTION_STRING;

const CHAIN_ID = 1n;
const TOKEN_COUNT = 3_000;
const tokenAddress = (i: number) => `0x${i.toString(16)}`;

describe.skipIf(!SERVER)("persistPriceUpdates against Postgres", () => {
  const database = `persist_price_updates_${process.pid}_${Date.now()}`;
  let admin: Sql;
  let sql: Sql<{ bigint: bigint }>;

  beforeAll(async () => {
    admin = postgres(SERVER!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);

    const url = new URL(SERVER!);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), {
      max: 20,
      onnotice: () => {},
    }) as unknown as Sql<{ bigint: bigint }>;

    await shift({
      sql: sql as unknown as Sql,
      path: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../migrations",
      ),
    });

    await sql`
      INSERT INTO erc20_tokens (
        chain_id, token_address, token_symbol, token_name, token_decimals,
        visibility_priority, sort_order
      )
      SELECT ${CHAIN_ID.toString()}::int8, i, 'T' || i, 'Token ' || i, 18, 0, 0
      FROM generate_series(1, ${TOKEN_COUNT}) AS i
    `;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  const updates = (indices: readonly number[]): PriceUpdate[] => {
    const timestamp = new Date();
    return indices.map((i) => ({
      chainId: CHAIN_ID,
      tokenAddress: tokenAddress(i),
      timestamp,
      usdPrice: 1 + i / TOKEN_COUNT,
    }));
  };

  const persist = (source: string, indices: readonly number[]) =>
    Effect.runPromise(
      Effect.result(
        persistPriceUpdates(sql, source, updates(indices), 180_000),
      ),
    );

  test("concurrent jobs on one chain do not deadlock", async () => {
    // Shaped on the production failures: a Sushi batch covering thousands of
    // tokens, in the fetcher's order rather than sorted, persisting while the
    // Chainlink and CoinGecko jobs on the same chain write a few tokens spread
    // across the address range. Before EKU-562 the Sushi batch went in as
    // 1,000-row statements inside one transaction, and these deadlocked within
    // a round or two.
    const everyToken = Array.from({ length: TOKEN_COUNT }, (_, i) => i + 1);
    const descending = everyToken.toReversed();
    const sources = ["cl1", "cg1", "qp1"];

    const failures: string[] = [];
    for (let round = 0; round < 4; round++) {
      const big = persist("ss1", descending);
      const small = Array.from({ length: 30 }, async (_, k) => {
        await Bun.sleep(k * 4);
        const spread = [1, 2, 3].map(
          (part) => ((part * 997 + k * 31 + round) % TOKEN_COUNT) + 1,
        );
        return persist(sources[k % sources.length], spread);
      });

      for (const result of await Promise.all([big, ...small])) {
        if (Result.isFailure(result)) failures.push(result.failure.message);
      }
    }

    expect(failures).toEqual([]);

    const [{ count }] = await sql<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM erc20_tokens_latest_price
      WHERE chain_id = ${CHAIN_ID.toString()}::int8
    `;
    expect(Number(count)).toBe(TOKEN_COUNT);
  }, 60_000);

  test("the row count reports inserted rows, skipping unknown tokens", async () => {
    const result = await persist("ss1", [1, 2, TOKEN_COUNT + 1]);

    expect(Result.isSuccess(result) && result.success).toBe(2);
  });
});
