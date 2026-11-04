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
import { encodeAbiParameters, encodeFunctionResult, multicall3Abi } from "viem";
import type { PriceSyncJob } from "./fetchers/types";
import { persistPriceUpdates } from "./persistPriceUpdates";
import { lastStoredPriceAt, type PriceSyncSql } from "./worker";

const SERVER = process.env.TEST_PG_CONNECTION_STRING;

function feedRpc(round: { at: bigint }) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const rpc = (await request.json()) as { id: number; method: string };
      const result =
        rpc.method === "eth_chainId"
          ? "0x1"
          : encodeFunctionResult({
              abi: multicall3Abi,
              functionName: "aggregate3",
              result: [
                {
                  success: true,
                  returnData: encodeAbiParameters([{ type: "uint8" }], [8]),
                },
                {
                  success: true,
                  returnData: encodeAbiParameters(
                    [
                      { type: "uint80" },
                      { type: "int256" },
                      { type: "uint256" },
                      { type: "uint256" },
                      { type: "uint80" },
                    ],
                    [1n, 200_000_000n, round.at, round.at, 1n],
                  ),
                },
              ],
            });
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    },
  });
}

function startWorker(connection: string, rpcUrl: string) {
  const child = Bun.spawn([process.execPath, "src/price-sync/index.ts"], {
    cwd: resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH ?? "",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      PG_CONNECTION_STRING: connection,
      TOKEN_PRICE_SYNC_INTERVAL_MS: "60000",
      COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS: "0",
      COINGECKO_NATIVE_PRICE_SYNC_INTERVAL_SECONDS: "0",
      CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS: "1",
      EKUBO_QUOTER_URL: "http://127.0.0.1:9",
      CHAINLINK_TOKEN_PRICE_CONFIG: JSON.stringify({
        1: {
          rpcUrls: [rpcUrl],
          feeds: [
            {
              tokenAddress: "0x0000000000000000000000000000000000000001",
              feedAddress: "0x0000000000000000000000000000000000000002",
              maxAgeSeconds: 3600,
            },
          ],
        },
      }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk);
  };
  const drained = Promise.all([collect(child.stdout), collect(child.stderr)]);
  return {
    output: () => output,
    async stop() {
      child.kill("SIGTERM");
      await child.exited;
      await drained;
    },
  };
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Worker fixture timed out");
    await Bun.sleep(50);
  }
}

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

  test("the real worker persists prices and resumes after process restart", async () => {
    const round = { at: BigInt(Math.floor(Date.now() / 1_000) - 10) };
    const rpc = feedRpc(round);
    const url = new URL(SERVER!);
    url.pathname = `/${database}`;
    let worker = startWorker(url.toString(), rpc.url.toString());
    const prices = () => sql`
      SELECT value, "timestamp" FROM erc20_tokens_usd_prices
      WHERE chain_id = 1 AND token_address = 1 AND source = 'cl1'
      ORDER BY "timestamp"
    `;
    try {
      await waitFor(async () => (await prices()).length === 1);
      expect(Number((await prices())[0].value)).toBe(2);
      await worker.stop();
      expect(worker.output()).toContain(
        "Closed the price-sync connection pool",
      );
      const stored = await prices();
      round.at += 1n;
      worker = startWorker(url.toString(), rpc.url.toString());
      await waitFor(async () =>
        worker.output().includes("Price sync job 1:cl1 completed"),
      );
      await waitFor(async () => (await prices()).length === 2);
      expect((await prices())[0]).toEqual(stored[0]);
      expect((await prices()).map((row) => Number(row.value))).toEqual([2, 2]);
    } catch (error) {
      throw new Error(worker.output(), { cause: error });
    } finally {
      await worker.stop();
      await rpc.stop(true);
    }
  }, 30_000);
});
