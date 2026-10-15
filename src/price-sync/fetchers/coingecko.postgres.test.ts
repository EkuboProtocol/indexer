import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import postgres, { type Sql } from "postgres";
import shift from "postgres-shift";
import { coingeckoPriceFetcher } from "./coingecko";

const SERVER = process.env.TEST_PG_CONNECTION_STRING;

const CHAIN_ID = 1n;
const realFetch = globalThis.fetch;

const TOKENS = {
  prominent: { address: 0x10n, visibility: 1, pool: null },
  liquid: { address: 0x20n, visibility: 0, pool: [5n, 0n] },
  drained: { address: 0x30n, visibility: 0, pool: [0n, 0n] },
  hiddenLiquid: { address: 0x40n, visibility: -1, pool: [5n, 5n] },
  poolless: { address: 0x50n, visibility: 0, pool: null },
} as const;
const OTHER_SIDE = 0x99n;

const padded = (address: bigint) =>
  `0x${address.toString(16).padStart(40, "0")}`;

describe.skipIf(!SERVER)("coingecko token read against Postgres", () => {
  const database = `coingecko_token_read_${process.pid}_${Date.now()}`;
  let admin: Sql;
  let sql: Sql<{ bigint: bigint }>;

  beforeAll(async () => {
    admin = postgres(SERVER!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);

    const url = new URL(SERVER!);
    url.pathname = `/${database}`;
    sql = postgres(url.toString(), {
      max: 2,
      onnotice: () => {},
    }) as unknown as Sql<{ bigint: bigint }>;

    await shift({
      sql: sql as unknown as Sql,
      path: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../migrations",
      ),
    });

    for (const [symbol, token] of Object.entries(TOKENS)) {
      await sql`
        INSERT INTO erc20_tokens (
          chain_id, token_address, token_symbol, token_name, token_decimals,
          visibility_priority, sort_order
        )
        VALUES (
          ${CHAIN_ID.toString()}::int8, ${token.address.toString()}::numeric,
          ${symbol}, ${symbol}, 18, ${token.visibility}, 0
        )
      `;
      if (!token.pool) continue;
      const [{ pool_key_id }] = await sql<{ pool_key_id: string }[]>`
        INSERT INTO pool_keys (
          chain_id, core_address, pool_id, token0, token1, fee,
          fee_denominator, tick_spacing, pool_extension
        )
        VALUES (
          ${CHAIN_ID.toString()}::int8, 1, ${token.address.toString()}::numeric,
          ${token.address.toString()}::numeric, ${OTHER_SIDE.toString()}::numeric,
          0, 1, 1, 0
        )
        RETURNING pool_key_id::TEXT
      `;
      await sql`
        INSERT INTO pool_tvl (pool_key_id, balance0, balance1)
        VALUES (
          ${pool_key_id}::int8, ${token.pool[0].toString()}::numeric,
          ${token.pool[1].toString()}::numeric
        )
      `;
    }
  }, 120_000);

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  const requestedAddresses = async (
    includeTokensWithEkuboLiquidity: boolean,
  ): Promise<string[]> => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      const addresses = new URL(String(input)).searchParams.get(
        "contract_addresses",
      );
      requested.push(...(addresses ?? "").split(","));
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const job = coingeckoPriceFetcher({
      sql,
      chainId: CHAIN_ID,
      intervalMs: 900_000,
      platform: "ethereum",
      apiKey: "test-key",
      minVisibilityPriority: 1,
      includeTokensWithEkuboLiquidity,
    });
    await Effect.runPromise(Stream.runCollect(job.fetch));
    return requested.sort();
  };

  test("a visibility minimum alone asks only about prominent tokens", async () => {
    expect(await requestedAddresses(false)).toEqual([
      padded(TOKENS.prominent.address),
    ]);
  });

  test("selectable tokens with Ekubo liquidity join the prominent ones", async () => {
    expect(await requestedAddresses(true)).toEqual([
      padded(TOKENS.prominent.address),
      padded(TOKENS.liquid.address),
    ]);
  });
});
