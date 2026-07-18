import {
  createPublicClient,
  fallback,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
} from "viem";

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
}

export type ChainlinkPriceConfig = Record<string, ChainlinkChainConfig>;

export interface ChainlinkPriceObservation {
  usdPrice: number;
  timestamp: Date;
}

interface ChainlinkReader {
  getChainId(): Promise<number>;
  readContract(args: {
    address: Address;
    abi: typeof CHAINLINK_AGGREGATOR_ABI;
    functionName: "decimals" | "latestRoundData";
  }): Promise<unknown>;
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

      const chain = assertObject(value, `Chainlink config for chain ${chainId}`);
      if (!Array.isArray(chain.feeds) || chain.feeds.length === 0) {
        throw new Error(
          `Chainlink feeds for chain ${chainId} must be a non-empty array`,
        );
      }

      const seenTokens = new Set<string>();
      const feeds = chain.feeds.map((value, index) => {
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

      return [
        chainId,
        {
          rpcUrls: parseRpcUrls(
            chain.rpcUrls,
            `Chainlink RPC URLs for chain ${chainId}`,
          ),
          feeds,
        },
      ];
    }),
  );
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

export async function fetchChainlinkTokenPrices(
  chainId: string,
  config: ChainlinkChainConfig,
): Promise<Record<string, ChainlinkPriceObservation>> {
  const client = createPublicClient({
    transport: fallback(config.rpcUrls.map((rpcUrl) => http(rpcUrl))),
  }) as unknown as ChainlinkReader;

  const rpcChainId = await client.getChainId();
  if (BigInt(rpcChainId) !== BigInt(chainId)) {
    throw new Error(
      `Chainlink RPC for chain ${chainId} returned chain ID ${rpcChainId}`,
    );
  }

  const prices: Record<string, ChainlinkPriceObservation> = {};
  await Promise.all(
    config.feeds.map(async (feed) => {
      try {
        prices[feed.tokenAddress] = await readChainlinkFeedPrice(client, feed);
      } catch (error) {
        console.warn(
          `Failed to fetch Chainlink price for ${feed.tokenAddress} on chain ${chainId}`,
          error,
        );
      }
    }),
  );
  return prices;
}
