import { Block as EvmBlock } from "@apibara/evm";
import { EvmRpcStream, rateLimitedHttp } from "@apibara/evm-rpc";
import { createRpcClient } from "@apibara/protocol/rpc";
import { createPublicClient, fallback } from "viem";
import type { EventKey } from "../_shared/eventKey";
import { logger } from "../_shared/logger";
import {
  loadHexAddresses,
  loadOptionalHexAddress,
  type HexAddress,
} from "../_shared/loadHexAddresses";
import { parseEvmRpcUrls } from "../_shared/streamEndpoints";
import { createLogProcessorsV2 } from "../evm/logProcessorsV2";
import { createLogProcessorsV3 } from "../evm/logProcessorsV3";
import { parsePositionsProtocolFeeConfigs } from "../evm/positionsProtocolFeeConfig";
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

export function isEvmBlock(block: unknown): block is EvmBlock {
  return Boolean(block && typeof block === "object" && "logs" in block);
}

export async function createEvmEntrypoint(
  chainId: bigint,
): Promise<NetworkEntrypoint<EvmBlock>> {
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

  if (!evmV2AddressConfig && !evmV3AddressConfig) {
    throw new Error("No config for either V2 or V3 contracts");
  }

  if (evmV2AddressConfig)
    logger.info(`Indexing V2 EVM contracts`, { evmV2AddressConfig });
  if (evmV3AddressConfig)
    logger.info(`Indexing V3 EVM contracts`, { evmV3AddressConfig });
  if (positionsV3ProtocolFeeConfigs?.length)
    logger.info(`Loaded V3 positions protocol fee configs`, {
      positionsV3ProtocolFeeConfigs,
    });

  const processors = [
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
          ]),
          positionsContracts: positionsV3ProtocolFeeConfigs ?? [],
        })
      : []),
  ];

  const createTransportFromUrl = (url: string) =>
    rateLimitedHttp(url, { rps: 100, retryCount: 0 });

  const evmRpcUrls = parseEvmRpcUrls(process.env.EVM_RPC_URL);

  if (evmRpcUrls.length === 0) {
    throw new Error("Missing EVM_RPC_URL");
  }

  const evmRpcTransports = evmRpcUrls.map((url) => ({
    url,
    transport: createTransportFromUrl(url),
  }));

  const publicClient = createPublicClient({
    transport: fallback(evmRpcTransports.map(({ transport }) => transport)),
  });

  const [clientChainId, transportChainIds] = await Promise.all([
    publicClient.getChainId(),
    Promise.all(
      evmRpcTransports.map(async ({ url, transport }) => ({
        url,
        chainId: BigInt(
          await createPublicClient({
            transport,
          }).getChainId(),
        ),
      })),
    ),
  ]);

  const uniqueChainIds = new Set<bigint>([
    BigInt(clientChainId),
    ...transportChainIds.map(({ chainId }) => chainId),
  ]);

  if (uniqueChainIds.size !== 1 || !uniqueChainIds.has(chainId)) {
    const transportDetails = transportChainIds
      .map(({ url, chainId }) => `${url}=${chainId}`)
      .join(", ");

    throw new Error(
      `EVM_RPC_URL transports return chain IDs [${transportDetails}] which conflict with environment chain ID ${chainId}`,
    );
  }

  const mergeGetLogsFilter = process.env.MERGE_GET_LOGS_FILTER;

  return {
    createStream(streamOptions: StreamOptions) {
      return createRpcClient(
        new EvmRpcStream(publicClient, {
          headRefreshIntervalMs: 2000,
          getLogsRangeSize: BigInt(process.env.GET_LOGS_RANGE_SIZE ?? 1_000_000n),
          alwaysSendAcceptedHeaders: true,
          mergeGetLogsFilter:
            mergeGetLogsFilter &&
            ["always", "accepted"].includes(mergeGetLogsFilter.toLowerCase())
              ? (mergeGetLogsFilter as "always" | "accepted")
              : false,
        }),
      ).streamData({
        ...streamOptions,
        filter: [
          {
            logs: processors.map((processor, ix) => ({
              id: ix + 1,
              address: processor.address,
              topics: processor.filter.topics,
              strict: processor.filter.strict,
            })),
          },
        ],
      });
    },
    getPlannedEvents(block: EvmBlock) {
      return block.logs.reduce(
        (total, log) => total + (log.filterIds?.length ?? 0),
        0,
      );
    },
    async processBlock({ block, blockNumber, dao }) {
      let eventsProcessed = 0;

      for (let i = 0; i < block.logs.length; i++) {
        const log = block.logs[i];

        const eventKey: EventKey = {
          blockNumber,
          transactionIndex: log.transactionIndex ?? 0,
          eventIndex: log.logIndexInTransaction ?? log.logIndex ?? i,
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
