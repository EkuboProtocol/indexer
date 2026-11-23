// Token UI multipliers, read from the chain into erc20_tokens_ui_multipliers.
//
// A UI multiplier is a display scale next to a token's decimals: Robinhood
// Stock Tokens show one raw token as uiMultiplier() / 1e18 shares, raise it
// after stock splits and as dividends compound, and can schedule the next value
// with newUIMultiplier() and effectiveAt(). Nothing here is specific to one
// issuer: every token of the chain is probed, and any that answers
// uiMultiplier() gets a row. The effective value is chosen at read time (see
// migration 00141), so a scheduled change flips on time between refreshes.
//
// Every token is probed once when the process starts and again whenever it
// first appears. Tokens with a multiplier are re-read every cycle, so an
// immediate updateMultiplier() lands within one interval; tokens without one
// are re-probed rarely.
import {
  decodeAbiParameters,
  getAddress,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import postgres from "postgres";
import { logger } from "../_shared/logger";

export const DEFAULT_MULTICALL3_ADDRESS: Address =
  "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

// uiMultiplier(), newUIMultiplier(), effectiveAt(), in that order: each takes
// no arguments, so its calldata is just the selector.
const SELECTORS: Hex[] = [
  "uiMultiplier()",
  "newUIMultiplier()",
  "effectiveAt()",
].map((signature) => toFunctionSelector(signature));

const MAX_ADDRESS = (1n << 160n) - 1n;

export interface UiMultiplierReading {
  /** uiMultiplier(), 18 decimals. Always positive. */
  uiMultiplier: bigint;
  /** newUIMultiplier(), or null when the token does not implement it. */
  newUiMultiplier: bigint | null;
  /** effectiveAt() in unix seconds, or null when not implemented. */
  effectiveAt: bigint | null;
}

export interface CallResult {
  success: boolean;
  returnData: Hex;
}

/** The minimal client surface: one eth_call through Multicall3. */
export interface UiMultiplierClient {
  readContract(args: {
    address: Address;
    abi: typeof MULTICALL3_ABI;
    functionName: "aggregate3";
    args: readonly [
      readonly { target: Address; allowFailure: boolean; callData: Hex }[],
    ];
  }): Promise<readonly CallResult[]>;
}

/**
 * A uint256 view result, or null for a revert or anything that is not exactly
 * one ABI word. A missing function reverts or, on a contract without a
 * fallback or an account without code, returns no data at all.
 */
export function decodeUint256(result: CallResult | undefined): bigint | null {
  if (!result?.success) return null;
  // One 32-byte word is "0x" plus 64 hex characters.
  if (result.returnData.length !== 66) return null;
  const [value] = decodeAbiParameters([{ type: "uint256" }], result.returnData);
  return value;
}

/** A token's reading, or null when it has no (usable) multiplier. */
export function readingFromResults(
  results: readonly (CallResult | undefined)[],
): UiMultiplierReading | null {
  const uiMultiplier = decodeUint256(results[0]);
  // Zero would hide every amount; treat it as no multiplier at all.
  if (uiMultiplier === null || uiMultiplier === 0n) return null;
  return {
    uiMultiplier,
    newUiMultiplier: decodeUint256(results[1]),
    effectiveAt: decodeUint256(results[2]),
  };
}

/**
 * Reads every token's multiplier at one block per chunk. Throws when a chunk's
 * own call fails (RPC error, no Multicall3), so a cycle never mistakes an
 * outage for tokens without the function.
 */
export async function readUiMultipliers(
  client: UiMultiplierClient,
  multicallAddress: Address,
  tokens: readonly bigint[],
  tokensPerCall = 150,
): Promise<Map<bigint, UiMultiplierReading | null>> {
  const readings = new Map<bigint, UiMultiplierReading | null>();
  for (let start = 0; start < tokens.length; start += tokensPerCall) {
    const chunk = tokens.slice(start, start + tokensPerCall);
    const results = await client.readContract({
      address: multicallAddress,
      abi: MULTICALL3_ABI,
      functionName: "aggregate3",
      args: [
        chunk.flatMap((token) => {
          const target = getAddress(
            `0x${token.toString(16).padStart(40, "0")}`,
          );
          return SELECTORS.map((callData) => ({
            target,
            allowFailure: true,
            callData,
          }));
        }),
      ],
    });
    if (results.length !== chunk.length * SELECTORS.length) {
      throw new Error(
        `Multicall3 returned ${results.length} results for ${chunk.length * SELECTORS.length} calls`,
      );
    }
    chunk.forEach((token, i) => {
      readings.set(
        token,
        readingFromResults(
          results.slice(i * SELECTORS.length, (i + 1) * SELECTORS.length),
        ),
      );
    });
  }
  return readings;
}

/**
 * Which tokens this cycle reads: every token that has a multiplier, every
 * token this process has not probed yet, and tokens without one whose last
 * probe is older than `absentReprobeMs`. `absentProbedAt` holds the last probe
 * of each token found without a multiplier.
 */
export function selectTokensToRead({
  tokens,
  stored,
  absentProbedAt,
  nowMs,
  absentReprobeMs,
}: {
  tokens: readonly bigint[];
  stored: ReadonlySet<bigint>;
  absentProbedAt: ReadonlyMap<bigint, number>;
  nowMs: number;
  absentReprobeMs: number;
}): bigint[] {
  return tokens.filter((token) => {
    if (token <= 0n || token > MAX_ADDRESS) return false;
    if (stored.has(token)) return true;
    const probedAt = absentProbedAt.get(token);
    return probedAt === undefined || nowMs - probedAt >= absentReprobeMs;
  });
}

type RefresherSql = postgres.Sql<{ bigint: bigint }>;

export interface RefreshSummary {
  tokens: number;
  read: number;
  withMultiplier: number;
  removed: number;
}

export async function refreshUiMultipliers({
  sql,
  chainId,
  client,
  multicallAddress,
  absentProbedAt,
  absentReprobeMs,
  nowMs = Date.now(),
}: {
  sql: RefresherSql;
  chainId: bigint;
  client: UiMultiplierClient;
  multicallAddress: Address;
  absentProbedAt: Map<bigint, number>;
  absentReprobeMs: number;
  nowMs?: number;
}): Promise<RefreshSummary> {
  const [tokenRows, storedRows] = await Promise.all([
    sql<{ token_address: string }[]>`
      SELECT token_address::TEXT AS token_address
      FROM erc20_tokens
      WHERE chain_id = ${chainId}
    `,
    sql<{ token_address: string }[]>`
      SELECT token_address::TEXT AS token_address
      FROM erc20_tokens_ui_multipliers
      WHERE chain_id = ${chainId}
    `,
  ]);
  const tokens = tokenRows.map((row) => BigInt(row.token_address));
  const stored = new Set(storedRows.map((row) => BigInt(row.token_address)));

  const toRead = selectTokensToRead({
    tokens,
    stored,
    absentProbedAt,
    nowMs,
    absentReprobeMs,
  });
  const readings = await readUiMultipliers(client, multicallAddress, toRead);

  const present: {
    chain_id: string;
    token_address: string;
    ui_multiplier: string;
    new_ui_multiplier: string | null;
    effective_at: string | null;
  }[] = [];
  const removed: string[] = [];
  for (const [token, reading] of readings) {
    if (reading) {
      absentProbedAt.delete(token);
      present.push({
        chain_id: chainId.toString(),
        token_address: token.toString(),
        ui_multiplier: reading.uiMultiplier.toString(),
        new_ui_multiplier: reading.newUiMultiplier?.toString() ?? null,
        effective_at: reading.effectiveAt?.toString() ?? null,
      });
    } else {
      absentProbedAt.set(token, nowMs);
      if (stored.has(token)) removed.push(token.toString());
    }
  }

  await sql.begin(async (tx) => {
    if (present.length > 0) {
      await tx`
        INSERT INTO erc20_tokens_ui_multipliers ${tx(
          present.map((row) => ({ ...row, checked_at: new Date(nowMs) })),
        )}
        ON CONFLICT (chain_id, token_address) DO UPDATE SET
          ui_multiplier = EXCLUDED.ui_multiplier,
          new_ui_multiplier = EXCLUDED.new_ui_multiplier,
          effective_at = EXCLUDED.effective_at,
          checked_at = EXCLUDED.checked_at
      `;
    }
    if (removed.length > 0) {
      await tx`
        DELETE FROM erc20_tokens_ui_multipliers
        WHERE chain_id = ${chainId}
          AND token_address = ANY(${removed}::NUMERIC[])
      `;
    }
  });

  return {
    tokens: tokens.length,
    read: toRead.length,
    withMultiplier: present.length,
    removed: removed.length,
  };
}

function nonNegativeSeconds(name: string, fallbackSeconds: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackSeconds;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

export interface UiMultiplierRefresherConfig {
  intervalMs: number;
  absentReprobeMs: number;
  multicallAddress: Address;
}

/** Null when disabled (`UI_MULTIPLIER_REFRESH_INTERVAL_SECONDS=0`). */
export function loadUiMultiplierRefresherConfig(): UiMultiplierRefresherConfig | null {
  const intervalSeconds = nonNegativeSeconds(
    "UI_MULTIPLIER_REFRESH_INTERVAL_SECONDS",
    300,
  );
  if (intervalSeconds === 0) return null;
  const multicall = process.env.MULTICALL3_ADDRESS?.trim();
  return {
    intervalMs: intervalSeconds * 1_000,
    absentReprobeMs:
      nonNegativeSeconds("UI_MULTIPLIER_ABSENT_REPROBE_SECONDS", 86_400) *
      1_000,
    multicallAddress: multicall
      ? getAddress(multicall)
      : DEFAULT_MULTICALL3_ADDRESS,
  };
}

/**
 * Runs the refresher beside the indexer until the process exits. A failed
 * cycle is logged and retried on the next one; nothing here can stop
 * indexing. Its timer is unref'd so it never keeps an exiting process alive.
 */
export function startUiMultiplierRefresher({
  chainId,
  pgConnectionString,
  client,
  config,
}: {
  chainId: bigint;
  pgConnectionString: string;
  client: UiMultiplierClient;
  config: UiMultiplierRefresherConfig;
}): () => Promise<void> {
  const sql = postgres(pgConnectionString, {
    max: 1,
    connect_timeout: 10,
    types: { bigint: postgres.BigInt },
    connection: { application_name: "ui-multiplier-refresher" },
  }) as unknown as RefresherSql;
  const absentProbedAt = new Map<bigint, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const cycle = async () => {
    const startedAt = Date.now();
    try {
      const summary = await refreshUiMultipliers({
        sql,
        chainId,
        client,
        multicallAddress: config.multicallAddress,
        absentProbedAt,
        absentReprobeMs: config.absentReprobeMs,
      });
      logger.info({
        message: "Refreshed token UI multipliers",
        ...summary,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.warn({
        message: "Token UI multiplier refresh failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void cycle(), config.intervalMs);
        timer.unref?.();
      }
    }
  };
  void cycle();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await sql.end({ timeout: 0 });
  };
}
