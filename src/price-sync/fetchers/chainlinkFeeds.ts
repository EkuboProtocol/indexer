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

type ChainlinkCatalogEntry = {
  proxyAddress?: unknown;
  secondaryProxyAddress?: unknown;
  heartbeat?: unknown;
  path?: unknown;
  feedCategory?: unknown;
  docs?: {
    baseAsset?: unknown;
    quoteAsset?: unknown;
    deliveryChannelCode?: unknown;
    productType?: unknown;
    productTypeCode?: unknown;
    hidden?: unknown;
    shutdownDate?: unknown;
  };
};

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

// The catalog carries every Chainlink data product, most of which are not USD
// spot price feeds we can read. These are the admissibility rules, as a table
// rather than one long conjunction: each rule is named, so a feed that fails to
// appear can be traced to the exact rule that rejected it.
const CATALOG_ENTRY_RULES: [string, (value: ChainlinkCatalogEntry) => boolean][] =
  [
    ["is a data feed", (v) => v.docs?.deliveryChannelCode === "DF"],
    ["is a price product", (v) => v.docs?.productType === "Price"],
    [
      "is a reference or tokenized price",
      (v) =>
        ["RefPrice", "primaryTokenizedPrice"].includes(
          String(v.docs?.productTypeCode),
        ),
    ],
    ["is quoted in USD", (v) => v.docs?.quoteAsset === "USD"],
    ["names a base asset", (v) => typeof v.docs?.baseAsset === "string"],
    ["is not hidden", (v) => v.docs?.hidden !== true],
    ["is not shut down", (v) => !v.docs?.shutdownDate],
    ["is not deprecating", (v) => v.feedCategory !== "deprecating"],
    ["has a path", (v) => typeof v.path === "string"],
    [
      "has a proxy address",
      (v) => typeof v.proxyAddress === "string" && isAddress(v.proxyAddress),
    ],
    [
      "has a usable heartbeat",
      (v) =>
        typeof v.heartbeat === "number" &&
        Number.isSafeInteger(v.heartbeat) &&
        v.heartbeat > 0 &&
        v.heartbeat <= MAX_CHAINLINK_HEARTBEAT_SECONDS,
    ],
  ];

function isUsableCatalogEntry(value: ChainlinkCatalogEntry): boolean {
  return CATALOG_ENTRY_RULES.every(([, holds]) => holds(value));
}

// Lower is better. A feed with no secondary proxy is the plain one and wins
// outright; among the rest, the shared SVR path is preferred.
function feedRank(value: ChainlinkCatalogEntry): number {
  if (!value.secondaryProxyAddress) return 0;
  return String(value.path).includes("shared-svr") ? 1 : 2;
}

export function discoverChainlinkFeeds(
  catalog: unknown,
  tokens: ChainlinkToken[],
): ChainlinkFeedConfig[] {
  if (!Array.isArray(catalog)) {
    throw new Error("Chainlink feed catalog must be an array");
  }

  const tokensBySymbol = groupTokensBySymbol(tokens);

  const catalogFeedsBySymbol = new Map<
    string,
    { feed: ChainlinkFeedConfig; rank: number }[]
  >();
  for (const rawValue of catalog) {
    if (!rawValue || typeof rawValue !== "object") continue;
    const value = rawValue as ChainlinkCatalogEntry;
    if (!isUsableCatalogEntry(value)) continue;

    const symbol = normalizeSymbol(value.docs!.baseAsset as string);
    const matchingTokens = tokensBySymbol.get(symbol);
    if (matchingTokens?.length !== 1) continue;

    const feed: ChainlinkFeedConfig = {
      tokenAddress: matchingTokens[0].address,
      feedAddress: getAddress(value.proxyAddress),
      maxAgeSeconds: chainlinkFeedMaxAgeSeconds(value.heartbeat),
    };
    const feeds = catalogFeedsBySymbol.get(symbol) ?? [];
    feeds.push({ feed, rank: feedRank(value) });
    catalogFeedsBySymbol.set(symbol, feeds);
  }

  return [...catalogFeedsBySymbol.values()]
    .map((feeds) => {
      const bestRank = Math.min(...feeds.map(({ rank }) => rank));
      const bestFeeds = feeds.filter(({ rank }) => rank === bestRank);
      return bestFeeds.length === 1 ? bestFeeds[0].feed : null;
    })
    .filter((feed): feed is ChainlinkFeedConfig => feed !== null);
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

export async function fetchChainlinkTokenPrices(
  chainId: string,
  config: ChainlinkChainConfig,
): Promise<Record<string, ChainlinkPriceObservation>> {
  const client = createPublicClient({
    transport: fallback(config.rpcUrls.map((rpcUrl) => http(rpcUrl))),
  }) as unknown as ChainlinkReader & ChainlinkMulticallReader;

  const rpcChainId = await client.getChainId();
  if (BigInt(rpcChainId) !== BigInt(chainId)) {
    throw new Error(
      `Chainlink RPC for chain ${chainId} returned chain ID ${rpcChainId}`,
    );
  }

  return fetchChainlinkTokenPricesWithMulticall(client, chainId, config);
}
