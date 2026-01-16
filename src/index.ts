import "./config";
import type { EventKey } from "./_shared/eventKey";
import { logger } from "./_shared/logger";
import { DAO, type IndexerCursor } from "./_shared/dao";
import { Block as EvmBlock, EvmStream } from "@apibara/evm";
import { EvmRpcStream, rateLimitedHttp } from "@apibara/evm-rpc";
import { Block as StarknetBlock, StarknetStream } from "@apibara/starknet";
import { createLogProcessorsV2 } from "./evm/logProcessorsV2";
import { createLogProcessorsV3 } from "./evm/logProcessorsV3";
import { parsePositionsProtocolFeeConfigs } from "./evm/positionsProtocolFeeConfig";
import { createEventProcessors } from "./starknet/eventProcessors";
import { createClient, Metadata } from "@apibara/protocol";
import { msToHumanShort } from "./_shared/msToHumanShort";
import { loadHexAddresses } from "./_shared/loadHexAddresses";
import { createRpcClient } from "@apibara/protocol/rpc";
import { createPublicClient, fallback, http, webSocket } from "viem";
import { EvmLogProcessor } from "./evm/logProcessorsShared";

function isNetworkTypeValid(
  networkType: string | undefined
): networkType is "starknet" | "evm" {
  return Boolean(networkType && ["starknet", "evm"].includes(networkType));
}

const NETWORK_TYPE = process.env.NETWORK_TYPE;

if (!isNetworkTypeValid(NETWORK_TYPE)) {
  throw new Error(`Invalid NETWORK_TYPE: "${NETWORK_TYPE}"`);
}

if (!process.env.NETWORK) {
  throw new Error(`Missing NETWORK`);
}

const chainId = BigInt(process.env.CHAIN_ID!);

if (!chainId) {
  throw new Error("Missing CHAIN_ID");
}

const dao = DAO.create(process.env.PG_CONNECTION_STRING!, chainId);

// Timer for exiting if no blocks are received within the configured time
const NO_BLOCKS_TIMEOUT_MS = parseInt(process.env.NO_BLOCKS_TIMEOUT_MS || "0");
let noBlocksTimer: NodeJS.Timeout | null = null;

const statsBlockIntervalRaw = parseInt(
  process.env.EVENT_STATS_BLOCK_INTERVAL || "100",
  10
);
const EVENT_STATS_BLOCK_INTERVAL = Number.isNaN(statsBlockIntervalRaw)
  ? 100
  : statsBlockIntervalRaw;
let statsBlocksProcessed = 0;
let statsEventsInserted = 0;
let statsProcessingTimeMs = 0;
let statsLagReducedMs = 0;
let lastObservedLagMs: number | null = null;

// Function to set or reset the no-blocks timer
function resetNoBlocksTimer() {
  // Clear existing timer if it exists
  if (noBlocksTimer) {
    clearTimeout(noBlocksTimer);
  }

  // Only set a new timer if the timeout is greater than 0
  if (NO_BLOCKS_TIMEOUT_MS > 0) {
    noBlocksTimer = setTimeout(() => {
      logger.error(
        `No blocks received in the last ${msToHumanShort(
          NO_BLOCKS_TIMEOUT_MS,
          2
        )}. Exiting process.`
      );
      process.exit(1);
    }, NO_BLOCKS_TIMEOUT_MS);
  }
}

(async function () {
  {
    logger.info({ message: `Acquiring lock for chain ID ${chainId}` });
    const lockTimer = logger.startTimer();
    await dao.acquireLock();
    lockTimer.done({ message: `Acquired lock for chain ID ${chainId}` });
  }

  // first set up the schema
  let currentCursor: IndexerCursor;
  {
    const initializeTimer = logger.startTimer();

    currentCursor = await dao.begin(async (dao) => {
      const databaseStartingCursor = await dao.loadCursor();
      if (databaseStartingCursor) {
        return databaseStartingCursor;
      } else {
        return dao.writeCursor(
          {
            orderKey: BigInt(process.env.STARTING_CURSOR_BLOCK_NUMBER!),
          },
          // should never happen but so this will cause it to revert if there's a race condition
          { orderKey: 0n }
        );
      }
    });

    initializeTimer.done({
      message: "Prepared indexer state",
      startingCursor: currentCursor,
    });
  }

  // Start the no-blocks timer when application starts
  resetNoBlocksTimer();

  const evmV2AddressConfig =
    NETWORK_TYPE === "evm"
      ? loadHexAddresses({
          mevCaptureAddress: "MEV_CAPTURE_ADDRESS",
          coreAddress: "CORE_ADDRESS",
          positionsAddress: "POSITIONS_ADDRESS",
          oracleAddress: "ORACLE_ADDRESS",
          twammAddress: "TWAMM_ADDRESS",
          ordersAddress: "ORDERS_ADDRESS",
          incentivesAddress: "INCENTIVES_ADDRESS",
          tokenWrapperFactoryAddress: "TOKEN_WRAPPER_FACTORY_ADDRESS",
        })
      : undefined;

  const evmV3AddressConfig =
    NETWORK_TYPE === "evm"
      ? loadHexAddresses({
          mevCaptureAddress: "MEV_CAPTURE_V3_ADDRESS",
          boostedFeesAddress: "BOOSTED_FEES_V3_ADDRESS",
          coreAddress: "CORE_V3_ADDRESS",
          oracleAddress: "ORACLE_V3_ADDRESS",
          twammAddress: "TWAMM_V3_ADDRESS",
          ordersAddress: "ORDERS_V3_ADDRESS",
          incentivesAddress: "INCENTIVES_V3_ADDRESS",
          tokenWrapperFactoryAddress: "TOKEN_WRAPPER_FACTORY_V3_ADDRESS",
        })
      : undefined;

  const positionsV3ProtocolFeeConfigs =
    NETWORK_TYPE === "evm"
      ? parsePositionsProtocolFeeConfigs(
          process.env.POSITIONS_V3_PROTOCOL_FEE_CONFIGS
        )
      : undefined;

  if (NETWORK_TYPE === "evm") {
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
  }

  const starknetAddressConfig =
    NETWORK_TYPE === "starknet"
      ? loadHexAddresses({
          nftAddress: "NFT_ADDRESS",
          coreAddress: "CORE_ADDRESS",
          tokenRegistryAddress: "TOKEN_REGISTRY_ADDRESS",
          tokenRegistryV2Address: "TOKEN_REGISTRY_V2_ADDRESS",
          tokenRegistryV3Address: "TOKEN_REGISTRY_V3_ADDRESS",
          twammAddress: "TWAMM_ADDRESS",
          stakerAddress: "STAKER_ADDRESS",
          governorAddress: "GOVERNOR_ADDRESS",
          oracleAddress: "ORACLE_ADDRESS",
          limitOrdersAddress: "LIMIT_ORDERS_ADDRESS",
          splineLiquidityProviderAddress: "SPLINE_LIQUIDITY_PROVIDER_ADDRESS",
        })
      : undefined;

  if (NETWORK_TYPE === "starknet") {
    if (!starknetAddressConfig)
      throw new Error("Missing or invalid Starknet contract addresses");
    logger.info(`Indexing Starknet contracts`, { starknetAddressConfig });
  }

  const evmProcessors: EvmLogProcessor[] =
    NETWORK_TYPE === "evm"
      ? [
          ...(evmV2AddressConfig
            ? createLogProcessorsV2(evmV2AddressConfig)
            : []),
          ...(evmV3AddressConfig
            ? createLogProcessorsV3({
                ...evmV3AddressConfig,
                positionsContracts: positionsV3ProtocolFeeConfigs ?? [],
              })
            : []),
        ]
      : [];

  const starknetProcessors =
    NETWORK_TYPE === "starknet" && starknetAddressConfig
      ? createEventProcessors(starknetAddressConfig)
      : ([] as ReturnType<typeof createEventProcessors>);

  const streamOptions = {
    finality: "accepted",
    startingCursor: currentCursor!,
    heartbeatInterval: {
      seconds: 10n,
      nanos: 0,
    },
  } as const;

  const createTransportFromUrl = (url: string) =>
    rateLimitedHttp(url, { rps: 100, retryCount: 0 });

  const evmRpcTransports =
    NETWORK_TYPE === "evm" && process.env.EVM_RPC_URL
      ? process.env.EVM_RPC_URL.split(",")
          .map((url) => url.trim())
          .filter(Boolean)
          .map((url) => ({
            url,
            transport: createTransportFromUrl(url),
          }))
      : [];

  const publicClient =
    NETWORK_TYPE === "evm" && evmRpcTransports.length > 0
      ? createPublicClient({
          transport: fallback(
            evmRpcTransports.map(({ transport }) => transport)
          ),
        })
      : null;

  if (publicClient) {
    const [clientChainId, transportChainIds] = await Promise.all([
      publicClient.getChainId(),
      Promise.all(
        evmRpcTransports.map(async ({ url, transport }) => ({
          url,
          chainId: BigInt(
            await createPublicClient({
              transport,
            }).getChainId()
          ),
        }))
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
        `EVM_RPC_URL transports return chain IDs [${transportDetails}] which conflict with environment chain ID ${chainId}`
      );
    }
  }

  const MERGE_GET_LOGS_FILTER = process.env.MERGE_GET_LOGS_FILTER;

  const stream =
    NETWORK_TYPE === "evm"
      ? publicClient
        ? createRpcClient(
            new EvmRpcStream(publicClient, {
              // how often we look for a new head
              headRefreshIntervalMs: 2000,
              // This parameter changes based on the rpc provider.
              // The stream automatically shrinks the batch size when the provider returns an error.
              getLogsRangeSize: BigInt(
                process.env.GET_LOGS_RANGE_SIZE ?? 1_000_000n
              ),
              alwaysSendAcceptedHeaders: true,
              mergeGetLogsFilter:
                MERGE_GET_LOGS_FILTER &&
                ["always", "accepted"].includes(
                  MERGE_GET_LOGS_FILTER.toLowerCase()
                )
                  ? (MERGE_GET_LOGS_FILTER as "always" | "accepted")
                  : false,
            })
          ).streamData({
            ...streamOptions,
            filter: [
              {
                logs: evmProcessors.map((lp, ix) => ({
                  id: ix + 1,
                  address: lp.address,
                  topics: lp.filter.topics,
                  strict: lp.filter.strict,
                })),
              },
            ],
          })
        : createClient(EvmStream, process.env.APIBARA_URL!, {
            defaultCallOptions: {
              "*": {
                metadata: Metadata({
                  Authorization: `Bearer ${process.env.DNA_TOKEN}`,
                }),
              },
            },
          }).streamData({
            ...streamOptions,
            filter: [
              {
                logs: evmProcessors.map((lp, ix) => ({
                  id: ix + 1,
                  address: lp.address,
                  topics: lp.filter.topics,
                  strict: lp.filter.strict,
                })),
              },
            ],
          })
      : createClient(StarknetStream, process.env.APIBARA_URL!, {
          defaultCallOptions: {
            "*": {
              metadata: Metadata({
                Authorization: `Bearer ${process.env.DNA_TOKEN}`,
              }),
            },
          },
        }).streamData({
          ...streamOptions,
          filter: [
            {
              events: starknetProcessors.map((processor, ix) => ({
                id: ix + 1,
                address: processor.filter.fromAddress,
                keys: processor.filter.keys,
              })),
            },
          ],
        });

  for await (const message of stream) {
    switch (message._tag) {
      case "heartbeat": {
        logger.debug(`Heartbeat`);

        // Note: We don't reset the no-blocks timer on heartbeats, only when actual blocks are received
        break;
      }

      case "systemMessage": {
        switch (message.systemMessage.output?._tag) {
          case "stderr":
            logger.error(`System message: ${message.systemMessage.output}`);
            break;
          case "stdout":
            logger.info(`System message: ${message.systemMessage.output}`);
            break;
        }
        break;
      }

      case "finalize": {
        const finalizedCursor = message.finalize.cursor;

        if (finalizedCursor) {
          logger.info({
            evt: "finalize",
            chainId,
            finalizedCursor,
          });

          await dao.updateFinalizedCursor(currentCursor, finalizedCursor);
        }

        break;
      }

      case "invalidate": {
        const invalidatedCursor = message.invalidate.cursor;
        if (!invalidatedCursor)
          throw new Error("invalidate message missing a cursor");

        if (invalidatedCursor) {
          logger.warn(`Cursor invalidated`, { cursor: invalidatedCursor });

          await dao.begin(async (dao) => {
            await dao.deleteOldBlockNumbers(
              Number(invalidatedCursor.orderKey) + 1
            );
            currentCursor = await dao.writeCursor(
              invalidatedCursor,
              currentCursor
            );
          });
        }

        break;
      }

      case "data": {
        // Reset the no-blocks timer since we received block data
        resetNoBlocksTimer();

        const endCursor = message.data.endCursor;
        if (!endCursor) {
          throw new Error("Received data message without an end cursor");
        }

        for (const block of message.data.data) {
          if (!block) continue;
          const blockProcessingTimer = logger.startTimer();
          const blockProcessingStartMs = Date.now();

          const blockNumber = Number(block.header.blockNumber);
          const blockTime = block.header.timestamp;

          const plannedEvents =
            NETWORK_TYPE === "evm"
              ? (block as EvmBlock).logs.reduce(
                  (total, log) => total + (log.filterIds?.length ?? 0),
                  0
                )
              : (block as StarknetBlock).events.reduce(
                  (total, event) => total + (event.filterIds?.length ?? 0),
                  0
                );

          let eventsProcessed = 0;

          await dao.begin(async (dao) => {
            await dao.deleteOldBlockNumbers(blockNumber);

            const blockHashHex = block.header.blockHash ?? "0x0";
            let baseFeePerGas: bigint | null = null;

            if ("baseFeePerGas" in block.header && block.header.baseFeePerGas) {
              baseFeePerGas = BigInt(block.header.baseFeePerGas);
            } else if (
              "l2GasPrice" in block.header &&
              block.header.l2GasPrice?.priceInFri
            ) {
              baseFeePerGas = BigInt(block.header.l2GasPrice.priceInFri);
            }

            await dao.insertBlock({
              number: block.header.blockNumber,
              hash: BigInt(blockHashHex),
              time: blockTime,
              baseFeePerGas,
              numEvents: plannedEvents,
            });

            if (NETWORK_TYPE === "evm") {
              const logs = (block as EvmBlock).logs;
              for (let i = 0; i < logs.length; i++) {
                const log = logs[i];

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

                    await evmProcessors[matchingFilterId - 1]!.handler(
                      dao,
                      eventKey,
                      {
                        topics: log.topics,
                        data: log.data,
                      }
                    );
                  })
                );
              }
            } else if (NETWORK_TYPE === "starknet") {
              const events = (block as StarknetBlock).events;
              for (const event of events) {
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
                    const processor = starknetProcessors[matchingFilterId - 1]!;
                    const { value: parsed } = processor.parser(event.data, 0);
                    await processor.handle(dao, { key: eventKey, parsed });
                  })
                );
              }
            }

            // endCursor is what we write so when we restart we delete any pending block information
            currentCursor = await dao.writeCursor(endCursor, currentCursor);
          });

          const nowMs = Date.now();
          const lagMs = Math.max(0, nowMs - Number(blockTime.getTime()));

          blockProcessingTimer.done({
            bNo: blockNumber,
            bTs: blockTime,
            evts: eventsProcessed,
            lag: msToHumanShort(lagMs, 2),
          });

          if (lastObservedLagMs !== null) {
            statsLagReducedMs += lastObservedLagMs - lagMs;
          }
          lastObservedLagMs = lagMs;

          if (EVENT_STATS_BLOCK_INTERVAL > 0) {
            const blockDurationMs = nowMs - blockProcessingStartMs;
            statsBlocksProcessed += 1;
            statsEventsInserted += eventsProcessed;
            statsProcessingTimeMs += blockDurationMs;

            if (statsBlocksProcessed === EVENT_STATS_BLOCK_INTERVAL) {
              const eventsPerSecond =
                statsProcessingTimeMs > 0
                  ? statsEventsInserted / (statsProcessingTimeMs / 1000)
                  : 0;

              const catchupMsPerSec =
                statsProcessingTimeMs > 0
                  ? (statsLagReducedMs * 1000) / statsProcessingTimeMs
                  : 0;

              const etaMs =
                catchupMsPerSec > 0 && lastObservedLagMs !== null
                  ? Math.round((lastObservedLagMs / catchupMsPerSec) * 1000)
                  : null;

              logger.info({
                evt: "ingest-stats",
                blocks: statsBlocksProcessed,
                events: statsEventsInserted,
                durationMs: Math.round(statsProcessingTimeMs),
                eps: Number(eventsPerSecond.toFixed(2)),
                lagMs: lastObservedLagMs,
                catchupMsPerSec: Number(catchupMsPerSec.toFixed(2)),
                eta: etaMs !== null ? msToHumanShort(etaMs, 2) : null,
              });

              statsBlocksProcessed = 0;
              statsEventsInserted = 0;
              statsProcessingTimeMs = 0;
              statsLagReducedMs = 0;
            }
          }
        }

        break;
      }

      default: {
        const unexpectedMessage: never = message;
        logger.error("Unhandled message type", unexpectedMessage);
        break;
      }
    }
  }
})()
  .then(() => {
    logger.info("Stream closed gracefully");
    process.exit(0);
  })
  .catch((error) => {
    logger.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await dao.releaseLock();
    await dao.end();
  });
