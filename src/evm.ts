import { createPublicClient, http } from "viem";
import type { EventKey } from "./_shared/eventKey";
import { logger } from "./_shared/logger";
import { parseCommonBlockHeader } from "./_shared/parseBlockHeader";
import {
  loadHexAddresses,
  loadOptionalHexAddress,
  type HexAddress,
} from "./_shared/loadHexAddresses";
import { withNullBlockRetry } from "./_shared/nullBlockRetry";
import { BLOCK_STREAM_DEFAULTS } from "./_shared/blockStream";
import { requireEvmRpcUrls } from "./_shared/streamEndpoints";
import {
  createLogStream,
  type LogStreamFilter,
  type StreamBlock as EvmBlock,
} from "./evm/logStream";
import { createLogProcessorsV2 } from "./evm/logProcessorsV2";
import { StickyRpc } from "./evm/stickyRpc";
import { createLogProcessorsV3 } from "./evm/logProcessorsV3";
import { parsePositionsProtocolFeeConfigs } from "./evm/positionsProtocolFeeConfig";
import { runIndexer, type ParsedRuntimeBlock } from "./runtime";
import type { NetworkEntrypoint, StreamOptions } from "./types";

function requireAtLeastOneAddress(
  label: string,
  envNames: string[],
): HexAddress[] {
  const addresses = envNames
    .map((envName) => loadOptionalHexAddress(envName))
    .filter((address): address is HexAddress => Boolean(address));

  if (addresses.length === 0) {
    throw new Error(
      `Missing ${label}. Set at least one of: ${envNames.join(", ")}`,
    );
  }

  return addresses;
}

export function parseEvmBlockHeader(
  block: unknown,
): ParsedRuntimeBlock<EvmBlock> | null {
  if (!block || typeof block !== "object") return null;

  const evmBlock = block as Partial<EvmBlock>;
  if (!evmBlock.header || !Array.isArray(evmBlock.logs)) return null;

  const { header } = evmBlock;
  const common = parseCommonBlockHeader(header);
  if (!common) return null;

  return {
    block: evmBlock as EvmBlock,
    header: {
      ...common,
      baseFeePerGas: header.baseFeePerGas ?? null,
    },
  };
}

function logIndexedContracts({
  evmV2AddressConfig,
  evmV3AddressConfig,
  positionsV3ProtocolFeeConfigs,
  evmV3Ve33AddressConfig,
}: {
  evmV2AddressConfig: unknown;
  evmV3AddressConfig: unknown;
  positionsV3ProtocolFeeConfigs: { length: number } | null | undefined;
  evmV3Ve33AddressConfig: {
    ve33Address: unknown;
    veTokenAddress: unknown;
    ve33PositionsAddress: unknown;
  };
}): void {
  if (evmV2AddressConfig)
    logger.info(`Indexing V2 EVM contracts`, { evmV2AddressConfig });
  if (evmV3AddressConfig)
    logger.info(`Indexing V3 EVM contracts`, { evmV3AddressConfig });
  if (positionsV3ProtocolFeeConfigs?.length)
    logger.info(`Loaded V3 positions protocol fee configs`, {
      positionsV3ProtocolFeeConfigs,
    });
  if (
    evmV3Ve33AddressConfig.ve33Address ||
    evmV3Ve33AddressConfig.veTokenAddress ||
    evmV3Ve33AddressConfig.ve33PositionsAddress
  )
    logger.info(`Indexing V3 Ve33 contracts`, { evmV3Ve33AddressConfig });
}

export function createEvmProcessors() {
  const evmV2AddressConfig = loadHexAddresses({
    mevCaptureAddress: "MEV_CAPTURE_ADDRESS",
    coreAddress: "CORE_ADDRESS",
    positionsAddress: "POSITIONS_ADDRESS",
    oracleAddress: "ORACLE_ADDRESS",
    twammAddress: "TWAMM_ADDRESS",
    ordersAddress: "ORDERS_ADDRESS",
    incentivesAddress: "INCENTIVES_ADDRESS",
    tokenWrapperFactoryAddress: "TOKEN_WRAPPER_FACTORY_ADDRESS",
  });

  const evmV3AddressConfig = loadHexAddresses({
    mevCaptureAddress: "MEV_CAPTURE_V3_ADDRESS",
    boostedFeesConcentratedAddress: "BOOSTED_FEES_CONCENTRATED_V3_ADDRESS",
    boostedFeesStableswapAddress: "BOOSTED_FEES_STABLESWAP_V3_ADDRESS",
    coreAddress: "CORE_V3_ADDRESS",
    oracleAddress: "ORACLE_V3_ADDRESS",
    incentivesAddress: "INCENTIVES_V3_ADDRESS",
    tokenWrapperFactoryAddress: "TOKEN_WRAPPER_FACTORY_V3_ADDRESS",
    auctionsAddress: "AUCTIONS_V3_ADDRESS",
  });

  const positionsV3ProtocolFeeConfigs = parsePositionsProtocolFeeConfigs(
    process.env.POSITIONS_V3_PROTOCOL_FEE_CONFIGS,
  );

  const evmV3Ve33AddressConfig = {
    ve33Address: loadOptionalHexAddress("VE33_V3_ADDRESS"),
    veTokenAddress: loadOptionalHexAddress("VE_TOKEN_V3_ADDRESS"),
    ve33PositionsAddress: loadOptionalHexAddress("VE33_POSITIONS_V3_ADDRESS"),
  };

  if (!evmV2AddressConfig && !evmV3AddressConfig) {
    throw new Error("No config for either V2 or V3 contracts");
  }

  logIndexedContracts({
    evmV2AddressConfig,
    evmV3AddressConfig,
    positionsV3ProtocolFeeConfigs,
    evmV3Ve33AddressConfig,
  });

  return [
    ...(evmV2AddressConfig ? createLogProcessorsV2(evmV2AddressConfig) : []),
    ...(evmV3AddressConfig
      ? createLogProcessorsV3({
          ...evmV3AddressConfig,
          twammAddresses: requireAtLeastOneAddress("V3 TWAMM address", [
            "TWAMM_V3_ADDRESS",
            "LEGACY_TWAMM_V3_ADDRESS",
          ]),
          ordersAddresses: requireAtLeastOneAddress("V3 Orders address", [
            "ORDERS_V3_ADDRESS",
            "LEGACY_ORDERS_V3_ADDRESS",
            "RECOMPILED_ORDERS_V3_ADDRESS",
          ]),
          ...evmV3Ve33AddressConfig,
          positionsContracts: positionsV3ProtocolFeeConfigs ?? [],
        })
      : []),
  ];
}

function positiveInt(name: string, fallbackValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackValue;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return parsed;
}

function suspectLogCounts(endpoints: number): number[] {
  const raw = process.env.SUSPECT_LOG_COUNT ?? "";
  const values =
    raw === "" ? ["10000"] : raw.split(",").map((value) => value.trim());
  if (values.length !== 1 && values.length !== endpoints) {
    throw new Error(
      `SUSPECT_LOG_COUNT must have one value or one per EVM_RPC_URL entry (${endpoints}), got ${values.length}`,
    );
  }
  return Array.from({ length: endpoints }, (_, i) => {
    const value = Number(values[values.length === 1 ? 0 : i]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `SUSPECT_LOG_COUNT entries must be positive integers, got ${raw}`,
      );
    }
    return value;
  });
}

function createStickyRpc(chainId: bigint): StickyRpc {
  const urls = requireEvmRpcUrls(process.env.EVM_RPC_URL);
  const caps = suspectLogCounts(urls.length);
  return new StickyRpc(
    urls.map((url, i) => ({
      label: new URL(url).origin,
      rpc: createPublicClient({
        transport: withNullBlockRetry(http(url, { retryCount: 2 }), { url }),
      }),
      suspectLogCount: caps[i]!,
    })),
    {
      chainId,
      staleHeadMs: positiveInt("RPC_STALE_HEAD_SECONDS", 120) * 1_000,
      failbackMs: positiveInt("RPC_FAILBACK_MINUTES", 15) * 60_000,
      probeIntervalMs: positiveInt("RPC_PROBE_INTERVAL_SECONDS", 30) * 1_000,
      onWarning: (message, detail) => logger.warn({ message, ...detail }),
    },
  );
}

export async function createEvmEntrypoint(
  chainId: bigint,
): Promise<NetworkEntrypoint<EvmBlock>> {
  const processors = createEvmProcessors();

  const rpc = createStickyRpc(chainId);
  await rpc.startWithin(
    BLOCK_STREAM_DEFAULTS.providerOutageBudgetMs,
    positiveInt("POLL_INTERVAL_MS", 2_000),
    positiveInt("MAX_POLL_INTERVAL_MS", 30_000),
  );

  const filters: LogStreamFilter[] = processors.map((processor, ix) => ({
    id: ix + 1,
    address: processor.address,
    topics: processor.filter.topics,
    strict: processor.filter.strict,
  }));

  return {
    createStream(streamOptions: StreamOptions) {
      return createLogStream({
        rpc,
        filters,
        startingCursor: streamOptions.startingCursor,
        loadPreviousCursor: streamOptions.loadPreviousCursor,
        loadStoredBlocks: streamOptions.loadStoredBlocks,
        endpoints: rpc,
        options: {
          pollIntervalMs: positiveInt("POLL_INTERVAL_MS", 2_000),
          maxPollIntervalMs: positiveInt("MAX_POLL_INTERVAL_MS", 30_000),
          quietPollsBeforeBackoff: positiveInt(
            "QUIET_POLLS_BEFORE_BACKOFF",
            30,
          ),
          maxLogRangeBlocks: positiveInt("GET_LOGS_RANGE_SIZE", 1_000),
          reorgWindowSeconds: positiveInt("REORG_WINDOW_SECONDS", 120),
          suspectLogCount: () => rpc.current.suspectLogCount,
          heartbeatIntervalMs: Number(
            streamOptions.heartbeatInterval.seconds * 1000n,
          ),
          onWarning: (message, detail) => logger.warn({ message, ...detail }),
        },
      });
    },
    getPlannedEvents(block: EvmBlock) {
      return block.logs.reduce((total, log) => total + log.filterIds.length, 0);
    },
    async processBlock({ block, blockNumber, dao }) {
      let eventsProcessed = 0;

      for (const log of block.logs) {
        const eventKey: EventKey = {
          blockNumber,
          transactionIndex: log.transactionIndex,
          // The block-wide log index, which is what `event_id` has always been
          // packed from on EVM. This used to read
          // `logIndexInTransaction ?? logIndex ?? i`, but the first was a field
          // of the apibara block type that no stream ever populated and the
          // last could not be reached, so both fell through to this every time.
          eventIndex: log.logIndex,
          emitter: log.address,
          transactionHash: log.transactionHash,
        };

        await Promise.all(
          log.filterIds.map(async (matchingFilterId: number) => {
            eventsProcessed++;

            await processors[matchingFilterId - 1]!.handler(dao, eventKey, {
              topics: log.topics,
              data: log.data,
            });
          }),
        );
      }

      return eventsProcessed;
    },
  };
}

if (import.meta.main) {
  await runIndexer({
    networkType: "evm",
    createEntrypoint: createEvmEntrypoint,
    parseBlockHeader: parseEvmBlockHeader,
  });
}
