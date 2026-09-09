import type { EventKey } from "./_shared/eventKey";
import { logger } from "./_shared/logger";
import { parseCommonBlockHeader } from "./_shared/parseBlockHeader";
import { loadHexAddresses } from "./_shared/loadHexAddresses";
import { requireStarknetRpcUrl } from "./_shared/streamEndpoints";
import { runIndexer, type ParsedRuntimeBlock } from "./runtime";
import { createEventProcessors } from "./starknet/eventProcessors";
import {
  createStarknetEventStream,
  createStarknetRpc,
  type StarknetStreamBlock,
  type StarknetStreamFilter,
} from "./starknet/eventStream";
import type { NetworkEntrypoint, StreamOptions } from "./types";

export function parseStarknetBlockHeader(
  block: unknown,
): ParsedRuntimeBlock<StarknetStreamBlock> | null {
  if (!block || typeof block !== "object") return null;

  const starknetBlock = block as Partial<StarknetStreamBlock>;
  if (!starknetBlock.header || !Array.isArray(starknetBlock.logs)) {
    return null;
  }

  const common = parseCommonBlockHeader(starknetBlock.header);
  if (!common) return null;

  return {
    block: starknetBlock as StarknetStreamBlock,
    header: {
      ...common,
      // The L2 gas price, which the stream reads from the head block. Only the
      // head's is stored -- `indexer_cursor.head_base_fee_per_gas`, which
      // quoter-service reads to price gas.
      baseFeePerGas: starknetBlock.header.baseFeePerGas ?? null,
    },
  };
}

export async function createStarknetEntrypoint(
  chainId: bigint,
): Promise<NetworkEntrypoint<StarknetStreamBlock>> {
  const starknetAddressConfig = loadHexAddresses({
    nftAddress: "NFT_ADDRESS",
    coreAddress: "CORE_ADDRESS",
    positionsAddress: "POSITIONS_ADDRESS",
    tokenRegistryAddress: "TOKEN_REGISTRY_ADDRESS",
    tokenRegistryV2Address: "TOKEN_REGISTRY_V2_ADDRESS",
    tokenRegistryV3Address: "TOKEN_REGISTRY_V3_ADDRESS",
    twammAddress: "TWAMM_ADDRESS",
    stakerAddress: "STAKER_ADDRESS",
    governorAddress: "GOVERNOR_ADDRESS",
    oracleAddress: "ORACLE_ADDRESS",
    limitOrdersAddress: "LIMIT_ORDERS_ADDRESS",
    splineLiquidityProviderAddress: "SPLINE_LIQUIDITY_PROVIDER_ADDRESS",
  });

  if (!starknetAddressConfig) {
    throw new Error("Missing or invalid Starknet contract addresses");
  }

  logger.info(`Indexing Starknet contracts`, { starknetAddressConfig });

  const processors = createEventProcessors(starknetAddressConfig);
  const rpc = createStarknetRpc(
    requireStarknetRpcUrl(process.env.STARKNET_RPC_URL),
  );

  const reportedChainId = await rpc.request<string>("starknet_chainId", []);
  if (BigInt(reportedChainId) !== chainId) {
    throw new Error(`Starknet RPC chain ID ${reportedChainId} conflicts with ${chainId}`);
  }

  const filters: StarknetStreamFilter[] = processors.map((processor, ix) => ({
    id: ix + 1,
    fromAddress: processor.filter.fromAddress,
    keys: processor.filter.keys,
  }));

  const positiveInt = (name: string, fallbackValue: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallbackValue;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer, got ${raw}`);
    }
    return parsed;
  };

  return {
    createStream(streamOptions: StreamOptions) {
      return createStarknetEventStream({
        rpc,
        filters,
        startingCursor: streamOptions.startingCursor,
        loadPreviousCursor: streamOptions.loadPreviousCursor,
        options: {
          pollIntervalMs: positiveInt("POLL_INTERVAL_MS", 2_000),
          // Starknet is never quiet for long -- it lands an event we index
          // roughly every thirteen seconds -- so the backoff this shares with
          // the EVM chains will rarely leave the floor. It is left armed
          // because "rarely" is not "never": the ceiling costs at most one
          // interval of latency, and NO_BLOCKS_TIMEOUT_MS is five minutes, far
          // above it.
          maxPollIntervalMs: positiveInt("MAX_POLL_INTERVAL_MS", 30_000),
          quietPollsBeforeBackoff: positiveInt("QUIET_POLLS_BEFORE_BACKOFF", 30),
          // ~0.59 blocks a second on mainnet, so the default 120 s window is
          // ~71 blocks and the span has to be at least twice that.
          maxLogRangeBlocks: positiveInt("GET_LOGS_RANGE_SIZE", 500),
          reorgWindowSeconds: positiveInt("REORG_WINDOW_SECONDS", 120),
          heartbeatIntervalMs: Number(
            streamOptions.heartbeatInterval.seconds * 1000n,
          ),
          onWarning: (message, detail) => logger.warn({ message, ...detail }),
        },
      });
    },
    getPlannedEvents(block: StarknetStreamBlock) {
      return block.logs.reduce(
        (total, event) => total + (event.filterIds?.length ?? 0),
        0,
      );
    },
    async processBlock({ block, blockNumber, dao }) {
      let eventsProcessed = 0;

      for (const event of block.logs) {
        const eventKey: EventKey = {
          blockNumber,
          transactionIndex: event.transactionIndex,
          eventIndex: event.eventIndex,
          emitter: event.address,
          transactionHash: event.transactionHash,
        };

        await Promise.all(
          event.filterIds.map(async (matchingFilterId: number) => {
            eventsProcessed++;
            const processor = processors[matchingFilterId - 1]!;
            const { value: parsed } = processor.parser(event.data, 0);
            await processor.handle(dao, { key: eventKey, parsed });
          }),
        );
      }

      return eventsProcessed;
    },
  };
}

if (import.meta.main) {
  await runIndexer({
    networkType: "starknet",
    createEntrypoint: createStarknetEntrypoint,
    parseBlockHeader: parseStarknetBlockHeader,
  });
}
