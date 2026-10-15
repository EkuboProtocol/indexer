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
import { persistPriceUpdates } from "../persistPriceUpdates";
import { bridgeMirrorPriceFetcher } from "./bridgeMirror";
import type { PriceUpdate } from "./types";

const SERVER = process.env.TEST_PG_CONNECTION_STRING;

const L1 = 1n;
const L2 = 130n;
const OTHER = 42161n;
const VALIDITY_MS = 180_000;

describe.skipIf(!SERVER)("bridgeMirrorPriceFetcher against Postgres", () => {
  const database = `bridge_mirror_${process.pid}_${Date.now()}`;
  let admin: Sql;
  let sql: Sql<{ bigint: bigint }>;

  beforeAll(async () => {
    admin = postgres(SERVER!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);

    const url = new URL(SERVER!);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), {
      max: 4,
      onnotice: () => {},
    }) as unknown as Sql<{ bigint: bigint }>;

    await shift({
      sql: sql as unknown as Sql,
      path: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../migrations",
      ),
    });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE erc20_tokens_usd_prices, erc20_tokens_latest_price_by_source, erc20_tokens_latest_price, erc20_tokens_bridge_relationships`;
    await sql`DELETE FROM erc20_tokens`;
  });

  async function token(chainId: bigint, address: bigint, visibility = 1) {
    await sql`
      INSERT INTO erc20_tokens (
        chain_id, token_address, token_symbol, token_name, token_decimals,
        visibility_priority, sort_order
      ) VALUES (${chainId}, ${address.toString()}, 'T', 'Token', 18, ${visibility}, 0)
    `;
  }

  async function bridge(
    from: [bigint, bigint],
    to: [bigint, bigint],
  ): Promise<void> {
    await sql`
      INSERT INTO erc20_tokens_bridge_relationships (
        source_chain_id, source_token_address, dest_chain_id, dest_token_address
      ) VALUES (${from[0]}, ${from[1].toString()}, ${to[0]}, ${to[1].toString()})
    `;
  }

  async function price(
    source: string,
    chainId: bigint,
    address: bigint,
    usdPrice: number,
  ): Promise<void> {
    await Effect.runPromise(
      persistPriceUpdates(
        sql,
        source,
        [
          {
            chainId,
            tokenAddress: `0x${address.toString(16)}`,
            timestamp: new Date(),
            usdPrice,
          },
        ],
        VALIDITY_MS,
      ),
    );
  }

  async function runMirror(chainIds = [L2, L1]): Promise<PriceUpdate[]> {
    const job = bridgeMirrorPriceFetcher({ sql, chainIds, intervalMs: 60_000 });
    const batches = await Effect.runPromise(Stream.runCollect(job.fetch));
    const updates = batches.flatMap((batch) => [...batch]);
    for (const batch of batches) {
      await Effect.runPromise(
        persistPriceUpdates(sql, job.source, batch, VALIDITY_MS),
      );
    }
    return updates;
  }

  async function latest(chainId: bigint, address: bigint) {
    const [row] = await sql<{ source: string; value: number }[]>`
      SELECT source::TEXT, value
      FROM erc20_tokens_latest_price
      WHERE chain_id = ${chainId} AND token_address = ${address.toString()}
    `;
    return row;
  }

  test("an unpriced bridged token takes its counterpart's price in either direction", async () => {
    await token(L1, 0xaaaan);
    await token(L2, 0xbbbbn);
    await token(L1, 0xccccn);
    await token(L2, 0xddddn);
    await bridge([L2, 0xbbbbn], [L1, 0xaaaan]);
    await bridge([L1, 0xccccn], [L2, 0xddddn]);
    await price("cg1", L1, 0xaaaan, 120);
    await price("ss1", L1, 0xccccn, 3);

    await runMirror();

    expect(await latest(L2, 0xbbbbn)).toEqual({ source: "bm1", value: 120 });
    expect(await latest(L2, 0xddddn)).toEqual({ source: "bm1", value: 3 });
  });

  test("a token with a price of its own is not mirrored, and wins if it gains one", async () => {
    await token(L1, 0xaaaan);
    await token(L2, 0xbbbbn);
    await bridge([L2, 0xbbbbn], [L1, 0xaaaan]);
    await price("cg1", L1, 0xaaaan, 120);
    await price("ss1", L2, 0xbbbbn, 119);

    expect(await runMirror()).toEqual([]);
    expect(await latest(L2, 0xbbbbn)).toEqual({ source: "ss1", value: 119 });

    await token(L2, 0xeeeen);
    await bridge([L2, 0xeeeen], [L1, 0xaaaan]);
    await runMirror();
    expect(await latest(L2, 0xeeeen)).toEqual({ source: "bm1", value: 120 });
    await price("ss1", L2, 0xeeeen, 118);
    expect(await latest(L2, 0xeeeen)).toEqual({ source: "ss1", value: 118 });
  });

  test("the highest-confidence counterpart wins, and mirrored prices are not copied on", async () => {
    await token(L1, 0xaaaan);
    await token(OTHER, 0xffffn);
    await token(L2, 0xbbbbn);
    await bridge([L2, 0xbbbbn], [L1, 0xaaaan]);
    await bridge([L2, 0xbbbbn], [OTHER, 0xffffn]);
    await price("ss1", L1, 0xaaaan, 100);
    await price("cg1", OTHER, 0xffffn, 101);

    await runMirror();
    expect(await latest(L2, 0xbbbbn)).toEqual({ source: "bm1", value: 101 });

    await token(L1, 0x1234n);
    await bridge([L1, 0x1234n], [L2, 0xbbbbn]);
    const updates = await runMirror();
    expect(updates.map((update) => update.tokenAddress)).not.toContain(
      "0x1234",
    );
  });

  test("hidden tokens and chains outside the job are skipped", async () => {
    await token(L1, 0xaaaan);
    await token(L2, 0xbbbbn, -1);
    await token(OTHER, 0xffffn);
    await bridge([L2, 0xbbbbn], [L1, 0xaaaan]);
    await bridge([OTHER, 0xffffn], [L1, 0xaaaan]);
    await price("cg1", L1, 0xaaaan, 120);

    expect(await runMirror([L2])).toEqual([]);
  });
});
