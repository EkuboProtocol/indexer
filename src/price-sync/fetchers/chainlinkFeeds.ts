import { Result, Schema } from "effect";
import {
  createPublicClient,
  fallback,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
} from "viem";

const DEFAULT_MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Real reference feeds publish at most daily. Bounding the catalog's heartbeat
// to a week keeps a garbage entry from producing a staleness window so large
// that downstream date arithmetic overflows, which would discard a whole
// chain's batch rather than just skipping the bad feed.
const MAX_CHAINLINK_HEARTBEAT_SECONDS = 7 * 24 * 60 * 60;

// A daily heartbeat means an equity feed: it publishes only while its market is
// open, so the longest gap between rounds is a market closure, not the
// heartbeat. Doubling the heartbeat gives 48h, which a plain weekend already
// outlives -- Friday's close is unreadable by Sunday evening while the market
// does not reopen until Monday. Five days clears a holiday weekend (Friday
// close to Tuesday open is about 89h) and still catches a genuinely dead feed
// within the week. Sub-daily feeds are continuous, so they keep the tight
// window that doubling gives them.
const CONTINUOUS_FEED_MAX_HEARTBEAT_SECONDS = 24 * 60 * 60;
const MARKET_CLOSURE_MAX_AGE_SECONDS = 5 * 24 * 60 * 60;

// Exported for the tests that pin the weekend behaviour.
export function chainlinkFeedMaxAgeSeconds(heartbeatSeconds: number): number {
  const doubled = heartbeatSeconds * 2;
  return heartbeatSeconds >= CONTINUOUS_FEED_MAX_HEARTBEAT_SECONDS
    ? Math.max(doubled, MARKET_CLOSURE_MAX_AGE_SECONDS)
    : doubled;
}

const CHAINLINK_AGGREGATOR_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export interface ChainlinkFeedConfig {
  tokenAddress: Address;
  feedAddress: Address;
  maxAgeSeconds: number;
}

export interface ChainlinkChainConfig {
  rpcUrls: string[];
  feeds: ChainlinkFeedConfig[];
  catalogUrl?: string;
  multicallAddress?: Address;
}

export type ChainlinkPriceConfig = Record<string, ChainlinkChainConfig>;

export interface ChainlinkPriceObservation {
  usdPrice: number;
  timestamp: Date;
}

export interface ChainlinkToken {
  address: Address;
  symbol: string;
}

interface ChainlinkReader {
  getChainId(): Promise<number>;
  readContract(args: {
    address: Address;
    abi: typeof CHAINLINK_AGGREGATOR_ABI;
    functionName: "decimals" | "latestRoundData";
  }): Promise<unknown>;
}

type ChainlinkMulticallResult =
  | { status: "success"; result: unknown }
  | { status: "failure"; error: Error };

interface ChainlinkMulticallReader {
  multicall(args: {
    contracts: {
      address: Address;
      abi: typeof CHAINLINK_AGGREGATOR_ABI;
      functionName: "decimals" | "latestRoundData";
    }[];
    allowFailure: true;
    batchSize: number;
    multicallAddress: Address;
  }): Promise<ChainlinkMulticallResult[]>;
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${label} must be a valid EVM address`);
  }
  return getAddress(value);
}

function parseRpcUrls(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }

  return value.map((rpcUrl, index) => {
    if (typeof rpcUrl !== "string") {
      throw new Error(`${label}[${index}] must be an HTTP(S) URL`);
    }
    let parsed: URL;
    try {
      parsed = new URL(rpcUrl);
    } catch {
      throw new Error(`${label}[${index}] must be an HTTP(S) URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${label}[${index}] must be an HTTP(S) URL`);
    }
    return rpcUrl;
  });
}

export function parseChainlinkPriceConfig(
  rawConfig: string | undefined,
): ChainlinkPriceConfig {
  if (!rawConfig) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    throw new Error("CHAINLINK_TOKEN_PRICE_CONFIG must be valid JSON", {
      cause: error,
    });
  }

  const chains = assertObject(parsed, "CHAINLINK_TOKEN_PRICE_CONFIG");
  return Object.fromEntries(
    Object.entries(chains).map(([chainId, value]) => {
      if (!/^[1-9][0-9]*$/.test(chainId)) {
        throw new Error(
          `Chainlink chain ID ${chainId} must be a positive integer`,
        );
      }

      const chain = assertObject(
        value,
        `Chainlink config for chain ${chainId}`,
      );
      let rawFeeds: unknown[] = [];
      if (chain.feeds !== undefined) {
        if (!Array.isArray(chain.feeds)) {
          throw new Error(
            `Chainlink feeds for chain ${chainId} must be an array`,
          );
        }
        rawFeeds = chain.feeds;
      }

      const seenTokens = new Set<string>();
      const feeds = rawFeeds.map((value, index) => {
        const label = `Chainlink feed ${chainId}[${index}]`;
        const feed = assertObject(value, label);
        const tokenAddress = parseAddress(
          feed.tokenAddress,
          `${label}.tokenAddress`,
        );
        const feedAddress = parseAddress(
          feed.feedAddress,
          `${label}.feedAddress`,
        );
        const maxAgeSeconds = feed.maxAgeSeconds;
        if (
          typeof maxAgeSeconds !== "number" ||
          !Number.isSafeInteger(maxAgeSeconds) ||
          maxAgeSeconds <= 0
        ) {
          throw new Error(`${label}.maxAgeSeconds must be a positive integer`);
        }

        const tokenKey = tokenAddress.toLowerCase();
        if (seenTokens.has(tokenKey)) {
          throw new Error(
            `Chainlink config for chain ${chainId} has duplicate token ${tokenAddress}`,
          );
        }
        seenTokens.add(tokenKey);

        return { tokenAddress, feedAddress, maxAgeSeconds };
      });

      let catalogUrl: string | undefined;
      if (chain.catalogUrl !== undefined) {
        [catalogUrl] = parseRpcUrls(
          [chain.catalogUrl],
          `Chainlink catalog URL for chain ${chainId}`,
        );
      }
      if (!catalogUrl && feeds.length === 0) {
        throw new Error(
          `Chainlink config for chain ${chainId} requires catalogUrl or feeds`,
        );
      }

      return [
        chainId,
        {
          rpcUrls: parseRpcUrls(
            chain.rpcUrls,
            `Chainlink RPC URLs for chain ${chainId}`,
          ),
          feeds,
          ...(catalogUrl ? { catalogUrl } : {}),
          ...(chain.multicallAddress === undefined
            ? {}
            : {
                multicallAddress: parseAddress(
                  chain.multicallAddress,
                  `Chainlink multicall address for chain ${chainId}`,
                ),
              }),
        },
      ];
    }),
  );
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function groupTokensBySymbol(
  tokens: ChainlinkToken[],
): Map<string, ChainlinkToken[]> {
  const bySymbol = new Map<string, ChainlinkToken[]>();
  for (const token of tokens) {
    const symbol = normalizeSymbol(token.symbol);
    const matches = bySymbol.get(symbol) ?? [];
    matches.push(token);
    bySymbol.set(symbol, matches);
  }
  return bySymbol;
}

/** An unconstrained field carrying only the named rule it must satisfy. */
function rule(name: string, holds: (value: unknown) => boolean) {
  return Schema.Unknown.pipe(
    Schema.refine((value): value is unknown => holds(value), {
      message: name,
    }),
  );
}

// The catalog carries every Chainlink data product, most of which are not USD
// spot price feeds we can read. This schema is the table of admissibility
// rules, and decoding an entry against it is what applies them.
//
// It replaces a table that paired each rule with a name and then threw the
// names away, so a feed that failed to appear could not be traced to the rule
// that rejected it. Decoding reports one: a structural rule reports the field
// and the value it wanted (`Expected "USD" at ["docs"]["quoteAsset"]`), which
// is more specific than a name; the rules that are bare predicates carry the
// name instead, since a path alone would say nothing.
//
// Decoding rather than validating is also what makes an accepted entry typed:
// `proxyAddress` is an `Address` and `heartbeat` a bounded integer on the way
// out, so building a feed from one needs no casts. The two `unknown`s that
// forced those casts were the last type errors in this file.
const UsableCatalogEntry = Schema.Struct({
  proxyAddress: Schema.String.pipe(
    Schema.refine((value): value is Address => isAddress(value), {
      message: "has a proxy address",
    }),
  ),
  heartbeat: Schema.Int.check(
    Schema.isBetween(
      { minimum: 1, maximum: MAX_CHAINLINK_HEARTBEAT_SECONDS },
      { message: "has a usable heartbeat" },
    ),
  ),
  path: Schema.String,
  secondaryProxyAddress: Schema.optional(Schema.Unknown),
  feedCategory: Schema.optional(
    rule("is not deprecating", (v) => v !== "deprecating"),
  ),
  docs: Schema.Struct({
    baseAsset: Schema.String,
    quoteAsset: Schema.Literal("USD"),
    deliveryChannelCode: Schema.Literal("DF"),
    productType: Schema.Literal("Price"),
    productTypeCode: Schema.Literals(["RefPrice", "primaryTokenizedPrice"]),
    hidden: Schema.optional(rule("is not hidden", (v) => v !== true)),
    shutdownDate: Schema.optional(rule("is not shut down", (v) => !v)),
  }),
});

type UsableCatalogEntry = typeof UsableCatalogEntry.Type;

const decodeCatalogEntry = Schema.decodeUnknownResult(UsableCatalogEntry);

// Decode failures are multi-line, and these are counted as map keys and read
// from a log line.
function rejectionReason(error: { readonly message: string }): string {
  return error.message.replace(/\s+/g, " ").trim();
}

// Lower is better. A feed with no secondary proxy is the plain one and wins
// outright; among the rest, the shared SVR path is preferred.
function feedRank(value: UsableCatalogEntry): number {
  if (!value.secondaryProxyAddress) return 0;
  return value.path.includes("shared-svr") ? 1 : 2;
}

// Reasons a decodable entry still does not become a feed. Both are ordinary,
// and both are otherwise invisible: a symbol the indexer does not carry, or
// carries twice, and two equally ranked feeds for one symbol where picking
// either would be a guess.
const NO_UNIQUE_TOKEN = "matches exactly one indexed token";
const NO_RANK_WINNER = "outranks the other feeds for its symbol";

export interface ChainlinkFeedDiscovery {
  readonly feeds: ChainlinkFeedConfig[];
  /**
   * How many catalog entries each rule rejected.
   *
   * The catalog lists every Chainlink product, so rejecting most of it is the
   * ordinary case and not a fault. This exists so that "why is this feed
   * missing" is answerable from a log line rather than a debugger.
   */
  readonly skipped: ReadonlyMap<string, number>;
}

export function discoverChainlinkFeedsDetailed(
  catalog: unknown,
  tokens: ChainlinkToken[],
): ChainlinkFeedDiscovery {
  if (!Array.isArray(catalog)) {
    throw new Error("Chainlink feed catalog must be an array");
  }

  const tokensBySymbol = groupTokensBySymbol(tokens);
  const skipped = new Map<string, number>();
  const skip = (reason: string) =>
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  const catalogFeedsBySymbol = new Map<
    string,
    { feed: ChainlinkFeedConfig; rank: number }[]
  >();
  for (const rawValue of catalog) {
    const decoded = decodeCatalogEntry(rawValue);
    if (Result.isFailure(decoded)) {
      skip(rejectionReason(decoded.failure));
      continue;
    }
    const value = decoded.success;

    const symbol = normalizeSymbol(value.docs.baseAsset);
    const matchingTokens = tokensBySymbol.get(symbol);
    if (matchingTokens?.length !== 1) {
      skip(NO_UNIQUE_TOKEN);
      continue;
    }

    const feed: ChainlinkFeedConfig = {
      tokenAddress: matchingTokens[0].address,
      feedAddress: getAddress(value.proxyAddress),
      maxAgeSeconds: chainlinkFeedMaxAgeSeconds(value.heartbeat),
    };
    const feeds = catalogFeedsBySymbol.get(symbol) ?? [];
    feeds.push({ feed, rank: feedRank(value) });
    catalogFeedsBySymbol.set(symbol, feeds);
  }

  const feeds: ChainlinkFeedConfig[] = [];
  for (const candidates of catalogFeedsBySymbol.values()) {
    const bestRank = Math.min(...candidates.map(({ rank }) => rank));
    const best = candidates.filter(({ rank }) => rank === bestRank);
    if (best.length === 1) {
      feeds.push(best[0].feed);
    } else {
      skip(NO_RANK_WINNER);
    }
  }

  return { feeds, skipped };
}

export function discoverChainlinkFeeds(
  catalog: unknown,
  tokens: ChainlinkToken[],
): ChainlinkFeedConfig[] {
  return discoverChainlinkFeedsDetailed(catalog, tokens).feeds;
}

export async function fetchChainlinkFeedCatalog(
  catalogUrl: string,
  fetchFn: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
): Promise<unknown> {
  const response = await fetchFn(catalogUrl, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Chainlink catalog request failed: ${response.status} ${response.statusText}`,
    );
  }

  // Validate the shape here rather than at use, so a 200 response carrying an
  // error object is treated as a failed fetch: callers fall back to the last
  // good catalog instead of caching a body that throws on every read.
  const catalog = await response.json();
  if (!Array.isArray(catalog)) {
    throw new Error(`Chainlink catalog ${catalogUrl} did not return an array`);
  }
  return catalog;
}

export async function readChainlinkFeedPrice(
  reader: Pick<ChainlinkReader, "readContract">,
  feed: ChainlinkFeedConfig,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<ChainlinkPriceObservation> {
  const [decimalsResult, roundDataResult] = await Promise.all([
    reader.readContract({
      address: feed.feedAddress,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals",
    }),
    reader.readContract({
      address: feed.feedAddress,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData",
    }),
  ]);

  return parseChainlinkFeedPrice(
    decimalsResult,
    roundDataResult,
    feed,
    nowSeconds,
  );
}

function parseChainlinkFeedPrice(
  decimalsResult: unknown,
  roundDataResult: unknown,
  feed: ChainlinkFeedConfig,
  nowSeconds = Math.floor(Date.now() / 1_000),
): ChainlinkPriceObservation {
  const decimals = decimalsResult as number;
  const [roundId, answer, , updatedAt, answeredInRound] =
    roundDataResult as readonly [bigint, bigint, bigint, bigint, bigint];

  if (answer <= 0n) throw new Error("oracle answer is not positive");
  if (updatedAt === 0n) throw new Error("oracle round is incomplete");
  if (answeredInRound < roundId) {
    throw new Error("oracle answer is from an old round");
  }
  if (BigInt(nowSeconds) - updatedAt > BigInt(feed.maxAgeSeconds)) {
    throw new Error(
      `oracle answer is older than ${feed.maxAgeSeconds} seconds`,
    );
  }

  const price = Number(formatUnits(answer, decimals));
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("oracle answer cannot be represented as a positive price");
  }
  return {
    usdPrice: price,
    timestamp: new Date(Number(updatedAt) * 1_000),
  };
}

export async function fetchChainlinkTokenPricesWithMulticall(
  reader: ChainlinkMulticallReader,
  chainId: string,
  config: ChainlinkChainConfig,
): Promise<Record<string, ChainlinkPriceObservation>> {
  const contracts = config.feeds.flatMap((feed) => [
    {
      address: feed.feedAddress,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals" as const,
    },
    {
      address: feed.feedAddress,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData" as const,
    },
  ]);
  const results = await reader.multicall({
    contracts,
    allowFailure: true,
    batchSize: Number.MAX_SAFE_INTEGER,
    multicallAddress: config.multicallAddress ?? DEFAULT_MULTICALL3_ADDRESS,
  });

  const prices: Record<string, ChainlinkPriceObservation> = {};
  config.feeds.forEach((feed, index) => {
    const decimalsResult = results[index * 2];
    const roundDataResult = results[index * 2 + 1];
    try {
      if (!decimalsResult) throw new Error("missing decimals result");
      if (decimalsResult.status === "failure") {
        throw decimalsResult.error;
      }
      if (!roundDataResult) throw new Error("missing round data result");
      if (roundDataResult.status === "failure") {
        throw roundDataResult.error;
      }
      prices[feed.tokenAddress] = parseChainlinkFeedPrice(
        decimalsResult.result,
        roundDataResult.result,
        feed,
      );
    } catch (error) {
      console.warn(
        `Failed to fetch Chainlink price for ${feed.tokenAddress} on chain ${chainId}`,
        error,
      );
    }
  });
  return prices;
}

/**
 * Verified clients, keyed by the chain and the endpoints they talk to.
 *
 * Both halves of this are worth keeping across calls. Building the client
 * allocates a fresh transport, and the `eth_chainId` that verifies it is a
 * request: this function runs once a minute per configured chain, so re-doing
 * both meant four `eth_chainId` calls a minute answering a question whose
 * answer cannot change -- a chain ID is a property of the endpoint, and the
 * endpoint comes from configuration that is fixed for the life of the process.
 *
 * The check itself is worth keeping. It is the only thing standing between an
 * RPC URL pointed at the wrong chain and a table of confidently wrong prices.
 * Once is enough.
 */
const verifiedClients = new Map<
  string,
  Promise<ChainlinkReader & ChainlinkMulticallReader>
>();

function createChainlinkClient(
  rpcUrls: readonly string[],
): ChainlinkReader & ChainlinkMulticallReader {
  return createPublicClient({
    transport: fallback(rpcUrls.map((rpcUrl) => http(rpcUrl))),
  }) as unknown as ChainlinkReader & ChainlinkMulticallReader;
}

export async function verifiedClient(
  chainId: string,
  rpcUrls: readonly string[],
  create: (
    urls: readonly string[],
  ) => ChainlinkReader & ChainlinkMulticallReader = createChainlinkClient,
): Promise<ChainlinkReader & ChainlinkMulticallReader> {
  const key = `${chainId}\u0000${rpcUrls.join(",")}`;

  const cached = verifiedClients.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const client = create(rpcUrls);

    const rpcChainId = await client.getChainId();
    if (BigInt(rpcChainId) !== BigInt(chainId)) {
      throw new Error(
        `Chainlink RPC for chain ${chainId} returned chain ID ${rpcChainId}`,
      );
    }
    return client;
  })();

  // Cache the attempt so concurrent callers share one `eth_chainId`, but drop
  // it again if it fails. A misconfigured URL will fail identically next minute;
  // a network blip during the first check should not disable the chain for the
  // life of the process.
  verifiedClients.set(key, pending);
  pending.catch(() => {
    if (verifiedClients.get(key) === pending) verifiedClients.delete(key);
  });

  return pending;
}

/** Test seam: forget every verified client. */
export function resetVerifiedChainlinkClients(): void {
  verifiedClients.clear();
}

export async function fetchChainlinkTokenPrices(
  chainId: string,
  config: ChainlinkChainConfig,
): Promise<Record<string, ChainlinkPriceObservation>> {
  const client = await verifiedClient(chainId, config.rpcUrls);
  return fetchChainlinkTokenPricesWithMulticall(client, chainId, config);
}
