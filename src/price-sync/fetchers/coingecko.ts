import { Clock, Effect, Ref, Stream } from "effect";
import type { Sql } from "postgres";
import { PriceSyncError, tryPriceSync } from "../errors";
import { fetchJson } from "../http";
import { makeCoinGeckoQuotaGate, type CoinGeckoQuotaGate } from "./coingeckoQuota";
import type { PriceSyncJob, PriceSyncJobOptions, PriceUpdate } from "./types";
import { toPriceUpdates } from "./utils";

export const COINGECKO_API_BASE_URL = "https://pro-api.coingecko.com/api/v3";
// Although CoinGecko accepts more addresses, large comma-separated batches can
// exceed the HTTP request-line limit before reaching the API.
const COINGECKO_MAX_CONTRACT_ADDRESSES = 100;
// How long to leave a token out of the rotation after CoinGecko declines to
// price it. Most of `erc20_tokens` is pool scaffolding and one-off deployments
// CoinGecko will never list, so re-asking every cycle costs requests forever
// and never yields a price.
const UNPRICED_REPROBE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

const TOKEN_SOURCE = "cg1";
const NATIVE_SOURCE = "cgn";

type CoinGeckoTokenPriceResponse = Record<string, { usd?: number }>;
type TokenAddressRow = { token_address: string };

interface CoinGeckoPriceFetcherOptions extends PriceSyncJobOptions {
  sql: Sql<{ bigint: bigint }>;
  platform: string;
  // Absent when COINGECKO_API_KEY is unset. The job still exists, and still
  // fails once per cycle saying so, rather than taking startup down for a
  // source the operator may not have enabled.
  apiKey: string | undefined;
  unpricedReprobeIntervalMs?: number;
  // Shared across every CoinGecko job; see `makeCoinGeckoQuotaGate`.
  quotaGate?: CoinGeckoQuotaGate;
}

interface CoinGeckoNativePriceFetcherOptions {
  intervalMs: number;
  // CoinGecko coin ID to the chains whose native currency it prices. Chains
  // sharing a coin ID are served by one request instead of one apiece.
  chainIdsByCoinId: Readonly<Record<string, readonly bigint[]>>;
  apiKey: string | undefined;
  quotaGate?: CoinGeckoQuotaGate;
}

function toEvmAddress(address: string): `0x${string}` {
  return `0x${BigInt(address).toString(16).padStart(40, "0")}`;
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
): Effect.Effect<`0x${string}`[], PriceSyncError> {
  return tryPriceSync({
    source: TOKEN_SOURCE,
    operation: `read indexed tokens for chain ${chainId}`,
    try: () => sql<TokenAddressRow[]>`
      SELECT token_address::TEXT
      FROM erc20_tokens
      WHERE chain_id = ${chainId}
        AND token_address > 0
      ORDER BY token_address
    `,
  }).pipe(
    Effect.map((tokens) =>
      tokens.map(({ token_address }) => toEvmAddress(token_address)),
    ),
  );
}

// Tokens this source priced recently enough that retention still holds the
// observation: at most a day past its expiry.
function fetchPricedTokenAddresses(
  sql: Sql<{ bigint: bigint }>,
  chainId: bigint,
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
      tokens.map(({ token_address }) => toEvmAddress(token_address)),
    ),
  );
}

function usablePrice(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Prices the native currency of every configured chain. Chains that share a
 * CoinGecko coin ID -- every EVM rollup settling in ETH, for instance -- are
 * priced by a single `simple/price` request rather than one request per chain.
 */
export function coingeckoNativePriceFetcher({
  intervalMs,
  chainIdsByCoinId,
  apiKey,
  quotaGate = makeCoinGeckoQuotaGate(),
}: CoinGeckoNativePriceFetcherOptions): PriceSyncJob {
  const coinIds = Object.keys(chainIdsByCoinId).sort();
  const chainIds = coinIds.flatMap((coinId) => [...chainIdsByCoinId[coinId]]);

  // One batch per chain, so a coin ID serving four chains still writes each
  // chain's row under its own chain ID.
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
                ).pipe(Stream.flatMap((result) => Stream.fromArray(toBatches(result)))),
              ),
            ),
          ),
  };
}

/**
 * Prices a chain's ERC20 tokens by contract address.
 *
 * Only tokens CoinGecko has actually priced are requested every cycle. The rest
 * -- the large majority of `erc20_tokens` on any chain -- are re-probed on a slow
 * rotation, which keeps request volume proportional to the tokens CoinGecko
 * covers instead of to the size of the table.
 *
 * The rotation survives a restart. The first cycle of a process seeds it from
 * the database: tokens with a retained `cg1` observation are the priced set, and
 * every other token already in the table counts as probed and waits for its
 * rotation slot. Without that, each deploy re-requested the whole table on
 * every chain. Only a chain with no retained `cg1` observation at all -- never
 * priced, or out of prices for over a day -- starts with a full sweep, since
 * there is nothing to seed from.
 */
export function coingeckoPriceFetcher({
  sql,
  chainId,
  intervalMs,
  platform,
  apiKey,
  unpricedReprobeIntervalMs = UNPRICED_REPROBE_INTERVAL_MS,
  quotaGate = makeCoinGeckoQuotaGate(),
}: CoinGeckoPriceFetcherOptions): PriceSyncJob {
  // Retained across cycles for the life of the process, and seeded from the
  // database on the first cycle so a restart does not start from nothing.
  //
  // `makeUnsafe` because these refs belong to the job, not to one run of it:
  // creating them inside the stream would reset the rotation every cycle and
  // put the whole table back into every request.
  const priced = Ref.makeUnsafe(new Set<string>());
  const probed = Ref.makeUnsafe(new Set<string>());
  const seeded = Ref.makeUnsafe(false);

  // Spread the re-probes of unpriced tokens evenly across the rotation window,
  // so each cycle carries roughly one slot's worth instead of the whole tail.
  const slotCount = Math.max(
    1,
    Math.round(unpricedReprobeIntervalMs / Math.max(intervalMs, 1)),
  );

  const seed = Effect.fn("coingecko.seed")(function* (
    addresses: readonly `0x${string}`[],
  ) {
    const retained = yield* fetchPricedTokenAddresses(sql, chainId);
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

  // Tokens can leave `erc20_tokens`; do not let the sets grow forever.
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
    // The slot follows the wall clock rather than a per-process counter. A
    // counter restarts at slot 0 with the process, so frequent deploys kept
    // re-probing the first slots and never reached the last ones.
    const now = yield* Clock.currentTimeMillis;
    const slot = Math.floor(now / Math.max(intervalMs, 1)) % slotCount;
    const pricedNow = yield* Ref.get(priced);
    const probedNow = yield* Ref.get(probed);

    return addresses.filter(
      (address, index) =>
        // CoinGecko prices it, so keep it fresh every cycle.
        pricedNow.has(address) ||
        // Never asked -- a token new to the table, or a cold start.
        !probedNow.has(address) ||
        // Due for its periodic re-probe in case CoinGecko has listed it since.
        index % slotCount === slot,
    );
  });

  const recordOutcome = Effect.fn("coingecko.recordOutcome")(function* (
    batch: readonly string[],
    pricedInBatch: ReadonlySet<string>,
  ) {
    const isPriced = (address: string) =>
      pricedInBatch.has(address.toLowerCase());

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
    if (result === undefined) return [];

    // CoinGecko lowercases the addresses it echoes back, so compare on the
    // requested form rather than trusting the response keys to match.
    const prices: [tokenAddress: string, usdPrice: number][] = [];
    const pricedInBatch = new Set<string>();
    for (const [address, { usd }] of Object.entries(result)) {
      if (usablePrice(usd)) {
        prices.push([address, usd]);
        pricedInBatch.add(address.toLowerCase());
      }
    }

    yield* recordOutcome(batch, pricedInBatch);

    return toPriceUpdates(chainId, prices);
  });

  const plan = Effect.fn("coingecko.plan")(function* () {
    const apiKey_ = yield* requireApiKey(TOKEN_SOURCE, apiKey);
    // Paused on the account's monthly quota: skip the table read as well.
    if (!(yield* quotaGate.isOpen)) return Stream.empty;

    const addresses = yield* fetchTokenAddresses(sql, chainId);

    if (!(yield* Ref.get(seeded))) yield* seed(addresses);
    yield* forgetDroppedTokens(new Set(addresses));
    const selected = yield* selectAddresses(addresses);

    return Stream.fromArray(batches(selected)).pipe(
      Stream.mapEffect((batch) => requestBatch(batch, apiKey_)),
      Stream.filter((updates) => updates.length > 0),
    );
  });

  return {
    chainIds: [chainId],
    source: TOKEN_SOURCE,
    intervalMs,
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
    result.push(addresses.slice(offset, offset + COINGECKO_MAX_CONTRACT_ADDRESSES));
  }
  return result;
}

// How often the account's remaining credits are logged for the monitor.
export const COINGECKO_CREDITS_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
export const CREDITS_MARKER = "COINGECKO_CREDITS";

interface CoinGeckoKeyUsage {
  plan?: string;
  monthly_call_credit?: number;
  current_total_monthly_calls?: number;
  current_remaining_monthly_calls?: number;
}

/**
 * Logs the account's monthly credit usage from `GET /key`, one greppable line
 * per check, and reopens a quota pause as soon as credits are back rather than
 * waiting out the rest of it.
 *
 * Runs outside the quota gate on purpose: the headroom reading matters most
 * while the gate is closed.
 */
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

    if (typeof remaining === "number" && remaining > 0) {
      yield* quotaGate.reopen(`credits available: remaining=${remaining}`);
    }
  },
);
