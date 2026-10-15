import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import postgres, { type Sql } from "postgres";
import shift from "postgres-shift";
import type { PriceSyncJob } from "./fetchers/types";
import { persistPriceUpdates } from "./persistPriceUpdates";
import { lastStoredPriceAt, type PriceSyncSql } from "./worker";

const SERVER = process.env.TEST_PG_CONNECTION_STRING;

describe.skipIf(!SERVER)("lastStoredPriceAt against Postgres", () => {
  const database = `worker_last_run_${process.pid}_${Date.now()}`;
  let admin: Sql;
  let sql: PriceSyncSql;

  beforeAll(async () => {
    admin = postgres(SERVER!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);

    const url = new URL(SERVER!);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), {
      max: 2,
      onnotice: () => {},
      types: { bigint: postgres.BigInt },
    });

    await shift({
      sql,
      path: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../migrations",
      ),
    });

    for (const chainId of [1n, 10n, 8453n]) {
      await sql`
        INSERT INTO erc20_tokens (
          chain_id, token_address, token_symbol, token_name, token_decimals,
          visibility_priority, sort_order
        ) VALUES (${chainId}, '1', 'T', 'Token', 18, 1, 0)
      `;
    }
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE erc20_tokens_usd_prices, erc20_tokens_latest_price_by_source, erc20_tokens_latest_price`;
  });

  const job = (source: string, chainIds: bigint[]): PriceSyncJob => ({
    chainIds,
    source,
    intervalMs: 60_000,
    resumeFromLastRun: true,
    fetch: Stream.empty,
  });

  const store = (source: string, chainId: bigint, at: string) =>
    Effect.runPromise(
      persistPriceUpdates(
        sql,
        source,
        [
          {
            chainId,
            tokenAddress: "0x1",
            timestamp: new Date(at),
            usdPrice: 1,
          },
        ],
        60_000,
      ),
    );

  test("returns the newest price of the job's source on its chains only", async () => {
    await store("cg1", 1n, "2026-10-14T10:00:00.000Z");
    await store("cg1", 10n, "2026-10-14T11:00:00.000Z");
    await store("cg1", 8453n, "2026-10-14T12:00:00.000Z");
    await store("cgn", 1n, "2026-10-14T13:00:00.000Z");

    const last = await Effect.runPromise(
      lastStoredPriceAt(sql, job("cg1", [1n, 10n])),
    );

    expect(last?.toISOString()).toBe("2026-10-14T11:00:00.000Z");
  });

  test("returns undefined when the source has no stored price", async () => {
    await store("cgn", 1n, "2026-10-14T13:00:00.000Z");

    const last = await Effect.runPromise(
      lastStoredPriceAt(sql, job("cg1", [1n])),
    );

    expect(last).toBeUndefined();
  });
});
