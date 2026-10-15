import { Clock, Effect, Ref, Stream } from "effect";
import type { Sql } from "postgres";
import { PriceSyncError, tryPriceSync } from "../errors";
import { fetchJson } from "../http";
import {
  makeCoinGeckoQuotaGate,
  type CoinGeckoQuotaGate,
} from "./coingeckoQuota";
import type { PriceSyncJob, PriceSyncJobOptions, PriceUpdate } from "./types";
import { toPriceUpdates } from "./utils";

export const COINGECKO_API_BASE_URL = "https://pro-api.coingecko.com/api/v3";
const COINGECKO_MAX_CONTRACT_ADDRESSES = 100;
const UNPRICED_REPROBE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const TOKEN_SOURCE = "cg1";
const NATIVE_SOURCE = "cgn";

type CoinGeckoTokenPriceResponse = Record<string, { usd?: number }>;
type TokenAddressRow = { token_address: string };

interface CoinGeckoPriceFetcherOptions extends PriceSyncJobOptions {
  sql: Sql<{ bigint: bigint }>;
  platform: string;
  apiKey: string | undefined;
  unpricedReprobeIntervalMs?: number;
  quotaGate?: CoinGeckoQuotaGate;
  minVisibilityPriority?: number;
  includeTokensWithEkuboLiquidity?: boolean;
  addressHexDigits?: 40 | 64;
}

interface CoinGeckoNativePriceFetcherOptions {
  intervalMs: number;
  chainIdsByCoinId: Readonly<Record<string, readonly bigint[]>>;
  apiKey: string | undefined;
  quotaGate?: CoinGeckoQuotaGate;
}

function toPaddedAddress(address: string, hexDigits: number): `0x${string}` {
  return `0x${BigInt(address).toString(16).padStart(hexDigits, "0")}`;
}

function requireApiKey(
  source: string,
  apiKey: string | undefined,
): Effect.Effect<string, PriceSyncError> {
  return apiKey
    ? Effect.succeed(apiKey)
    : Effect.fail(
        new PriceSyncError({
          source,
          operation: "read API key",
          cause: new Error(
            "COINGECKO_API_KEY is required when CoinGecko price syncing is enabled",
          ),
        }),
      );
}

function requestPrices({
  source,
  operation,
  path,
  apiKey,
}: {
  source: string;
  operation: string;
  path: string;
  apiKey: string;
}): Effect.Effect<CoinGeckoTokenPriceResponse, PriceSyncError> {
  return fetchJson<CoinGeckoTokenPriceResponse>({
    source,
    operation,
    url: `${COINGECKO_API_BASE_URL}${path}`,
    headers: { "x-cg-pro-api-key": apiKey },
  });
}

function fetchTokenAddresses(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
  minVisibilityPriority: number | null,
  includeTokensWithEkuboLiquidity: boolean,
  hexDigits: number,
): Effect.Effect<`0x${string}`[], PriceSyncError> {
  return tryPriceSync({
    source: TOKEN_SOURCE,
    operation: `read indexed tokens for chain ${chainId}`,
    try: () => sql<TokenAddressRow[]>`
      SELECT t.token_address::TEXT
      FROM erc20_tokens t
      WHERE t.chain_id = ${chainId}
        AND t.token_address > 0
        AND (
          ${minVisibilityPriority}::INT2 IS NULL
          OR t.visibility_priority >= ${minVisibilityPriority}::INT2
          OR (
            ${includeTokensWithEkuboLiquidity}::BOOLEAN
            AND t.visibility_priority >= 0
            AND EXISTS (
              SELECT 1
              FROM pool_keys pk
              JOIN pool_tvl pt USING (pool_key_id)
              WHERE pk.chain_id = t.chain_id
                AND (
                  pk.token0 = t.token_address
                  OR pk.token1 = t.token_address
                )
                AND (pt.balance0 > 0 OR pt.balance1 > 0)
            )
          )
        )
      ORDER BY t.token_address
    `,
  }).pipe(
    Effect.map((tokens) =>
      tokens.map(({ token_address }) =>
        toPaddedAddress(token_address, hexDigits),
      ),
    ),
  );
}

function fetchPricedTokenAddresses(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
  hexDigits: number,
): Effect.Effect<`0x${string}`[], PriceSyncError> {
  return tryPriceSync({
    source: TOKEN_SOURCE,
    operation: `read ${TOKEN_SOURCE} prices for chain ${chainId}`,
    try: () => sql<TokenAddressRow[]>`
      SELECT token_address::TEXT
      FROM erc20_tokens_latest_price_by_source
      WHERE chain_id = ${chainId}
        AND source = ${TOKEN_SOURCE}
    `,
  }).pipe(
    Effect.map((tokens) =>
      tokens.map(({ token_address }) =>
        toPaddedAddress(token_address, hexDigits),
      ),
    ),
  );
}

function usablePrice(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function coingeckoNativePriceFetcher({
  intervalMs,
  chainIdsByCoinId,
  apiKey,
  quotaGate = makeCoinGeckoQuotaGate(),
}: CoinGeckoNativePriceFetcherOptions): PriceSyncJob {
  const coinIds = Object.keys(chainIdsByCoinId).sort();
  const chainIds = coinIds.flatMap((coinId) => [...chainIdsByCoinId[coinId]]);

  const toBatches = (
    result: CoinGeckoTokenPriceResponse,
  ): readonly PriceUpdate[][] => {
    const timestamp = new Date();

    return coinIds.flatMap((coinId) => {
      const usdPrice = result[coinId]?.usd;
      if (!usablePrice(usdPrice)) return [];

      return chainIdsByCoinId[coinId].map((chainId) =>
        toPriceUpdates(chainId, [["0x0", usdPrice]], timestamp),
      );
    });
  };

  const query = new URLSearchParams({
    ids: coinIds.join(","),
    vs_currencies: "usd",
    precision: "full",
  });

  return {
    chainIds,
    source: NATIVE_SOURCE,
    intervalMs,
    resumeFromLastRun: true,
    fetch:
      coinIds.length === 0
        ? Stream.empty
        : Stream.unwrap(
            requireApiKey(NATIVE_SOURCE, apiKey).pipe(
              Effect.map((key) =>
                Stream.fromEffect(
                  quotaGate.guard(
                    requestPrices({
                      source: NATIVE_SOURCE,
                      operation: `native currencies ${coinIds.join(", ")}`,
                      path: `/simple/price?${query}`,
                      apiKey: key,
                    }),
                    {},
                  ),
                ).pipe(
                  Stream.flatMap((result) =>
                    Stream.fromArray(toBatches(result)),
                  ),
                ),
              ),
            ),
          ),
  };
}

export function coingeckoPriceFetcher({
  sql,
  chainId,
  intervalMs,
  platform,
  apiKey,
  unpricedReprobeIntervalMs = UNPRICED_REPROBE_INTERVAL_MS,
  quotaGate = makeCoinGeckoQuotaGate(),
  minVisibilityPriority,
  includeTokensWithEkuboLiquidity = false,
  addressHexDigits = 40,
}: CoinGeckoPriceFetcherOptions): PriceSyncJob {
  const priced = Ref.makeUnsafe(new Set<string>());
  const probed = Ref.makeUnsafe(new Set<string>());
  const seeded = Ref.makeUnsafe(false);
  const lastEpoch = Ref.makeUnsafe<number | undefined>(undefined);
  const firstEpoch = Ref.makeUnsafe<number | undefined>(undefined);

  const slotCount = Math.max(
    1,
    Math.round(unpricedReprobeIntervalMs / Math.max(intervalMs, 1)),
  );

  const seed = Effect.fn("coingecko.seed")(function* (
    addresses: readonly `0x${string}`[],
  ) {
    const retained = yield* fetchPricedTokenAddresses(
      sql,
      chainId,
      addressHexDigits,
    );
    yield* Ref.set(seeded, true);

    if (retained.length === 0) {
      yield* Effect.logInfo(
        `${TOKEN_SOURCE} chain ${chainId}: cold start, no retained ${TOKEN_SOURCE} prices; sweeping ${addresses.length} tokens`,
      );
      return;
    }

    const current = new Set(addresses);
    yield* Ref.set(
      priced,
      new Set(retained.filter((address) => current.has(address))),
    );
    yield* Ref.set(probed, current);
    yield* Effect.logInfo(
      `${TOKEN_SOURCE} chain ${chainId}: warm start, seeded ${retained.length} priced of ${addresses.length} tokens; no sweep`,
    );
  });

  const forgetDroppedTokens = Effect.fn("coingecko.forgetDroppedTokens")(
    function* (current: ReadonlySet<string>) {
      const known = yield* Ref.get(probed);
      const dropped = [...known].filter((address) => !current.has(address));
      if (dropped.length === 0) return;

      yield* Ref.update(probed, (set) => difference(set, dropped));
      yield* Ref.update(priced, (set) => difference(set, dropped));
    },
  );

  const selectAddresses = Effect.fn("coingecko.selectAddresses")(function* (
    addresses: readonly `0x${string}`[],
  ) {
    // Slots follow the wall clock rather than a per-process counter. A counter
    // restarts at slot 0 with the process, so frequent deploys kept re-probing
    // the first slots and never reached the last ones.
    //
    // Launches are phased from process start, not from the epoch boundary, so
    // with jitter two launches can land in one epoch, or one launch can jump
    // an epoch. Serving every epoch since the last one served -- none on a
    // repeat, two on a jump -- keeps each slot to exactly one pass per
    // rotation. A quota pause or a failed cycle catches up the same way,
    // capped at one rotation.
    const now = yield* Clock.currentTimeMillis;
    const epoch = Math.floor(now / Math.max(intervalMs, 1));
    const last = yield* Ref.get(lastEpoch);
    const start = yield* Ref.modify(firstEpoch, (previous) => {
      const value = previous ?? epoch;
      return [value, value];
    });
    const dueSlots = new Set<number>();
    const first = Math.max(
      last === undefined ? start : last + 1,
      epoch - slotCount + 1,
    );
    for (let due = first; due <= epoch; due++) dueSlots.add(due % slotCount);

    const pricedNow = yield* Ref.get(priced);
    const probedNow = yield* Ref.get(probed);

    const selected = addresses.filter(
      (address, index) =>
        pricedNow.has(address) ||
        !probedNow.has(address) ||
        dueSlots.has(index % slotCount),
    );
    return { selected, epoch };
  });

  const recordOutcome = Effect.fn("coingecko.recordOutcome")(function* (
    batch: readonly string[],
    pricedInBatch: ReadonlySet<string>,
  ) {
    const isPriced = (address: string) => pricedInBatch.has(address);

    yield* Ref.update(probed, (set) => new Set([...set, ...batch]));
    yield* Ref.update(priced, (set) => {
      const next = new Set(set);
      for (const address of batch) {
        if (isPriced(address)) next.add(address);
        else next.delete(address);
      }
      return next;
    });
  });

  const requestBatch = Effect.fn("coingecko.requestBatch")(function* (
    batch: readonly `0x${string}`[],
    apiKey: string,
    refused: Ref.Ref<boolean>,
  ) {
    const query = new URLSearchParams({
      contract_addresses: batch.join(","),
      vs_currencies: "usd",
      precision: "full",
    });
    // `undefined` when the quota gate is closed: the batch was not asked, so
    // its outcome must not be recorded as "CoinGecko does not price these".
    const result = yield* quotaGate.guard<
      CoinGeckoTokenPriceResponse | undefined
    >(
      requestPrices({
        source: TOKEN_SOURCE,
        operation: `token prices for chain ${chainId}`,
        path: `/simple/token_price/${platform}?${query}`,
        apiKey,
      }),
      undefined,
    );
    if (result === undefined) {
      yield* Ref.set(refused, true);
      return [];
    }

    const prices: [tokenAddress: string, usdPrice: number][] = [];
    const pricedInBatch = new Set<string>();
    for (const [address, { usd }] of Object.entries(result)) {
      if (usablePrice(usd)) {
        prices.push([address, usd]);
        pricedInBatch.add(toPaddedAddress(address, addressHexDigits));
      }
    }

    yield* recordOutcome(batch, pricedInBatch);

    return toPriceUpdates(chainId, prices);
  });

  const plan = Effect.fn("coingecko.plan")(function* () {
    const apiKey_ = yield* requireApiKey(TOKEN_SOURCE, apiKey);
    if (!(yield* quotaGate.isOpen)) return Stream.empty;

    const addresses = yield* fetchTokenAddresses(
      sql,
      chainId,
      minVisibilityPriority ?? null,
      includeTokensWithEkuboLiquidity,
      addressHexDigits,
    );

    if (!(yield* Ref.get(seeded))) yield* seed(addresses);
    yield* forgetDroppedTokens(new Set(addresses));
    const { selected, epoch } = yield* selectAddresses(addresses);
    const refused = yield* Ref.make(false);

    return Stream.fromArray(batches(selected)).pipe(
      Stream.mapEffect((batch) => requestBatch(batch, apiKey_, refused)),
      Stream.filter((updates) => updates.length > 0),
      Stream.onEnd(
        Effect.gen(function* () {
          if (yield* Ref.get(refused)) return;
          yield* Ref.update(lastEpoch, (previous) =>
            previous === undefined ? epoch : Math.max(previous, epoch),
          );
        }),
      ),
    );
  });

  return {
    chainIds: [chainId],
    source: TOKEN_SOURCE,
    intervalMs,
    resumeFromLastRun: true,
    fetch: Stream.unwrap(plan()),
  };
}

function difference(
  set: ReadonlySet<string>,
  removed: readonly string[],
): Set<string> {
  const next = new Set(set);
  for (const address of removed) next.delete(address);
  return next;
}

function batches(
  addresses: readonly `0x${string}`[],
): (readonly `0x${string}`[])[] {
  const result: (readonly `0x${string}`[])[] = [];
  for (
    let offset = 0;
    offset < addresses.length;
    offset += COINGECKO_MAX_CONTRACT_ADDRESSES
  ) {
    result.push(
      addresses.slice(offset, offset + COINGECKO_MAX_CONTRACT_ADDRESSES),
    );
  }
  return result;
}

export const COINGECKO_CREDITS_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
export const CREDITS_MARKER = "COINGECKO_CREDITS";
export const COINGECKO_REOPEN_MIN_REMAINING = 1_000;

interface CoinGeckoKeyUsage {
  plan?: string;
  monthly_call_credit?: number;
  current_total_monthly_calls?: number;
  current_remaining_monthly_calls?: number;
}

export const checkCoinGeckoCredits = Effect.fn("coingecko.checkCredits")(
  function* ({
    apiKey,
    quotaGate,
  }: {
    apiKey: string;
    quotaGate: CoinGeckoQuotaGate;
  }) {
    const usage = yield* fetchJson<CoinGeckoKeyUsage>({
      source: "cgk",
      operation: "read API key usage",
      url: `${COINGECKO_API_BASE_URL}/key`,
      headers: { "x-cg-pro-api-key": apiKey },
    });

    const limit = usage.monthly_call_credit;
    const used = usage.current_total_monthly_calls;
    const remaining = usage.current_remaining_monthly_calls;
    const remainingPct =
      typeof limit === "number" && limit > 0 && typeof remaining === "number"
        ? ((remaining / limit) * 100).toFixed(1)
        : "unknown";

    yield* Effect.logInfo(
      `${CREDITS_MARKER} plan=${usage.plan ?? "unknown"} limit=${limit ?? "unknown"} used=${used ?? "unknown"} remaining=${remaining ?? "unknown"} remaining_pct=${remainingPct}`,
    );

    if (
      typeof remaining === "number" &&
      remaining >= COINGECKO_REOPEN_MIN_REMAINING
    ) {
      yield* quotaGate.reopen(`credits available: remaining=${remaining}`);
    }
  },
);
