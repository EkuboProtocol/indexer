import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import shift from "postgres-shift";
import { encodeAbiParameters } from "viem";
import {
  refreshUiMultipliers,
  type CallResult,
  type UiMultiplierClient,
} from "./uiMultiplier";

const SERVER = process.env.TEST_PG_CONNECTION_STRING;

const CHAIN_ID = 4663n;
const E18 = 10n ** 18n;
const SNDK = 0xb90a19ff0af67f7779aff50a882a9cff42446400n;
const USDG = 0x1234n;
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";

const ok = (value: bigint): CallResult => ({
  success: true,
  returnData: encodeAbiParameters([{ type: "uint256" }], [value]),
});
const reverted: CallResult = { success: false, returnData: "0x" };

/** Answers uiMultiplier/newUIMultiplier/effectiveAt for the tokens in `values`. */
function chain(values: Map<bigint, [bigint, bigint, bigint]>) {
  const reads: bigint[][] = [];
  const client: UiMultiplierClient = {
    readContract: ({ args: [requests] }) => {
      const results = requests.map(({ target }, i) => {
        const value = values.get(BigInt(target));
        return value ? ok(value[i % 3] ?? 0n) : reverted;
      });
      reads.push(
        requests.filter((_, i) => i % 3 === 0).map((r) => BigInt(r.target)),
      );
      return Promise.resolve(results);
    },
  };
  return { client, reads };
}

describe.skipIf(!SERVER)("refreshUiMultipliers against Postgres", () => {
  const database = `ui_multipliers_${process.pid}_${Date.now()}`;
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
      types: { bigint: postgres.BigInt },
    });
    await shift({
      sql,
      path: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../migrations",
      ),
    });
    await sql`
      INSERT INTO erc20_tokens (chain_id, token_address, token_symbol, token_name,
                                token_decimals, visibility_priority, sort_order)
      VALUES (${CHAIN_ID}, ${SNDK.toString()}, 'SNDK', 'Sandisk', 18, 0, 0),
             (${CHAIN_ID}, ${USDG.toString()}, 'USDG', 'Global Dollar', 6, 0, 0),
             (1, ${SNDK.toString()}, 'X', 'Other chain', 18, 0, 0)
    `;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  const stored = async () => [
    ...(await sql<
      {
        token_address: string;
        ui_multiplier: string;
        new_ui_multiplier: string | null;
        effective_at: string | null;
        effective: string;
      }[]
    >`
    SELECT m.token_address::TEXT, m.ui_multiplier::TEXT,
           m.new_ui_multiplier::TEXT, m.effective_at::TEXT,
           e.ui_multiplier::TEXT AS effective
    FROM erc20_tokens_ui_multipliers m
    JOIN erc20_tokens_effective_ui_multipliers e USING (chain_id, token_address)
    WHERE m.chain_id = ${CHAIN_ID}
  `),
  ];

  test("stores tokens with a multiplier, re-reads them, and probes the rest rarely", async () => {
    const absentProbedAt = new Map<bigint, number>();
    const values = new Map([
      [SNDK, [E18, 8n * E18, 1795185000n] as [bigint, bigint, bigint]],
    ]);
    const first = chain(values);

    const summary = await refreshUiMultipliers({
      sql,
      chainId: CHAIN_ID,
      client: first.client,
      multicallAddress: MULTICALL,
      absentProbedAt,
      absentReprobeMs: 86_400_000,
      nowMs: 1_000_000,
    });
    expect(summary).toEqual({
      tokens: 2,
      read: 2,
      withMultiplier: 1,
      removed: 0,
      unreadable: 0,
    });
    expect(await stored()).toEqual([
      {
        token_address: SNDK.toString(),
        ui_multiplier: E18.toString(),
        new_ui_multiplier: (8n * E18).toString(),
        effective_at: "1795185000",
        // effectiveAt is in the past, so the scheduled value is in effect.
        effective: (8n * E18).toString(),
      },
    ]);

    // An immediate update lands on the next cycle; USDG is not probed again.
    values.set(SNDK, [9n * E18, 9n * E18, 1795185000n]);
    const second = chain(values);
    await refreshUiMultipliers({
      sql,
      chainId: CHAIN_ID,
      client: second.client,
      multicallAddress: MULTICALL,
      absentProbedAt,
      absentReprobeMs: 86_400_000,
      nowMs: 1_300_000,
    });
    expect(second.reads).toEqual([[SNDK]]);
    expect((await stored())[0]?.effective).toBe((9n * E18).toString());

    // A token that stops answering loses its row and so goes back to 1.
    values.clear();
    await refreshUiMultipliers({
      sql,
      chainId: CHAIN_ID,
      client: chain(values).client,
      multicallAddress: MULTICALL,
      absentProbedAt,
      absentReprobeMs: 86_400_000,
      nowMs: 1_600_000,
    });
    expect(await stored()).toEqual([]);
  });

  test("an RPC failure leaves stored rows alone", async () => {
    await sql`
      INSERT INTO erc20_tokens_ui_multipliers
        (chain_id, token_address, ui_multiplier, checked_at)
      VALUES (${CHAIN_ID}, ${SNDK.toString()}, ${(8n * E18).toString()}, NOW())
    `;
    const failing: UiMultiplierClient = {
      readContract: () => Promise.reject(new Error("upstream 503")),
    };
    expect(
      refreshUiMultipliers({
        sql,
        chainId: CHAIN_ID,
        client: failing,
        multicallAddress: MULTICALL,
        absentProbedAt: new Map(),
        absentReprobeMs: 86_400_000,
      }),
    ).rejects.toThrow("upstream 503");
    expect((await stored()).map((row) => row.ui_multiplier)).toEqual([
      (8n * E18).toString(),
    ]);
  });
});
