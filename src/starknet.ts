import { createRpcClient } from "@apibara/protocol/rpc";
import {
  StarknetRpcStream,
  type StarknetRpcBlock,
} from "@apibara/starknet-rpc";
import type { EventKey } from "./_shared/eventKey";
import { logger } from "./_shared/logger";
import { loadHexAddresses } from "./_shared/loadHexAddresses";
import {
  parseOptionalPositiveInteger,
  parseOptionalUrl,
  requireStarknetRpcUrl,
} from "./_shared/streamEndpoints";
import { runIndexer, type ParsedRuntimeBlock } from "./runtime";
import { createEventProcessors } from "./starknet/eventProcessors";
import type { NetworkEntrypoint, StreamOptions } from "./types";

export function parseStarknetBlockHeader(
  block: unknown,
): ParsedRuntimeBlock<StarknetRpcBlock> | null {
  if (!block || typeof block !== "object") return null;

  const starknetBlock = block as Partial<StarknetRpcBlock>;
  if (!starknetBlock.header || !Array.isArray(starknetBlock.events)) {
    return null;
  }

  const { header } = starknetBlock;
  if (
    typeof header.blockNumber !== "bigint" ||
    !(header.timestamp instanceof Date)
  ) {
    return null;
  }

  const blockNumber = Number(header.blockNumber);
  const timestamp = header.timestamp.getTime();
  if (!Number.isSafeInteger(blockNumber) || !Number.isFinite(timestamp)) {
    return null;
  }

  let hash: bigint;
  let baseFeePerGas: bigint | null = null;
  try {
    hash = BigInt(header.blockHash ?? "0x0");
    if (header.l2GasPrice?.priceInFri) {
      baseFeePerGas = BigInt(header.l2GasPrice.priceInFri);
    }
  } catch {
    return null;
  }

  return {
    block: starknetBlock as StarknetRpcBlock,
    header: {
      number: blockNumber,
      hash,
      timestamp,
      baseFeePerGas,
    },
  };
}

export function createStarknetEntrypoint(): NetworkEntrypoint<StarknetRpcBlock> {
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

  const url = requireStarknetRpcUrl(process.env.STARKNET_RPC_URL);
  const wsUrl = parseOptionalUrl(process.env.STARKNET_RPC_WS_URL);
  const requestsPerSecond = parseOptionalPositiveInteger(
    process.env.STARKNET_RPC_REQUESTS_PER_SECOND,
    "STARKNET_RPC_REQUESTS_PER_SECOND",
  );
  const maxConcurrency = parseOptionalPositiveInteger(
    process.env.STARKNET_RPC_MAX_CONCURRENCY,
    "STARKNET_RPC_MAX_CONCURRENCY",
  );

  logger.info(`Streaming Starknet blocks from JSON-RPC`, {
    url,
    wsUrl: wsUrl ?? null,
    requestsPerSecond: requestsPerSecond ?? null,
    maxConcurrency: maxConcurrency ?? null,
  });

  // The stream owns the capability probe results, the accepted block caches and
  // (when a websocket URL is configured) the head subscription, so it is built
  // once and reused across stream restarts.
  const stream = new StarknetRpcStream({
    url,
    wsUrl,
    requestsPerSecond,
    maxConcurrency,
  });

  return {
    createStream(streamOptions: StreamOptions) {
      return createRpcClient(stream).streamData({
        ...streamOptions,
        filter: [
          {
            events: processors.map((processor, ix) => ({
              id: ix + 1,
              address: processor.filter.fromAddress,
              keys: processor.filter.keys,
            })),
          },
        ],
      });
    },
    getPlannedEvents(block: StarknetRpcBlock) {
      return block.events.reduce(
        (total, event) => total + (event.filterIds?.length ?? 0),
        0,
      );
    },
    async processBlock({ block, blockNumber, dao }) {
      let eventsProcessed = 0;

      for (const event of block.events) {
        const eventKey: EventKey = {
          blockNumber,
          transactionIndex: event.transactionIndex,
          eventIndex: event.eventIndexInTransaction ?? event.eventIndex,
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
    createEntrypoint: () => createStarknetEntrypoint(),
    parseBlockHeader: parseStarknetBlockHeader,
  });
}
