import "./config";
import type { EventKey } from "./_shared/eventKey";
import { logger } from "./_shared/logger";
import { DAO, type IndexerCursor } from "./_shared/dao";
import { Block as EvmBlock, EvmStream } from "@apibara/evm";
import { Block as StarknetBlock, StarknetStream } from "@apibara/starknet";
import { createLogProcessors } from "./evm/logProcessors";
import { createEventProcessors } from "./starknet/eventProcessors";
import { Bytes, createClient, Metadata } from "@apibara/protocol";
import { msToHumanShort } from "./_shared/msToHumanShort";

if (!["starknet", "evm"].includes(process.env.NETWORK_TYPE)) {
  throw new Error(`Invalid NETWORK_TYPE: "${process.env.NETWORK_TYPE}"`);
}

if (!process.env.NETWORK) {
  throw new Error(`Missing NETWORK`);
}

const chainId = BigInt(process.env.CHAIN_ID);

const hexChainId = `0x${chainId.toString(16)}`;

if (!chainId) {
  throw new Error("Missing CHAIN_ID");
}

const dao = DAO.create(process.env.PG_CONNECTION_STRING, chainId);

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
    await dao.begin(async (dao) => {
      const databaseStartingCursor = await dao.loadCursor();
      if (databaseStartingCursor) {
        currentCursor = databaseStartingCursor;
      } else {
        currentCursor = await dao.writeCursor(
          {
            orderKey: BigInt(process.env.STARTING_CURSOR_BLOCK_NUMBER),
          },
          // should never happen but so this will cause it to revert if there's a race condition
          { orderKey: 0n }
        );

        initializeTimer.done({
          message: "Prepared indexer state",
          startingCursor: currentCursor,
        });
      }
    });
  }

  // Start the no-blocks timer when application starts
  resetNoBlocksTimer();

  const evmProcessors =
    process.env.NETWORK_TYPE === "evm"
      ? createLogProcessors({
          mevCaptureAddress: process.env.MEV_CAPTURE_ADDRESS,
          coreAddress: process.env.CORE_ADDRESS,
          positionsAddress: process.env.POSITIONS_ADDRESS,
          oracleAddress: process.env.ORACLE_ADDRESS,
          twammAddress: process.env.TWAMM_ADDRESS,
          ordersAddress: process.env.ORDERS_ADDRESS,
          incentivesAddress: process.env.INCENTIVES_ADDRESS,
          tokenWrapperFactoryAddress: process.env.TOKEN_WRAPPER_FACTORY_ADDRESS,
        })
      : ([] as ReturnType<typeof createLogProcessors>);

  const starknetProcessors =
    process.env.NETWORK_TYPE === "starknet"
      ? createEventProcessors({
          nftAddress: process.env.NFT_ADDRESS,
          coreAddress: process.env.CORE_ADDRESS,
          tokenRegistryAddress: process.env.TOKEN_REGISTRY_ADDRESS,
          tokenRegistryV2Address: process.env.TOKEN_REGISTRY_V2_ADDRESS,
          tokenRegistryV3Address: process.env.TOKEN_REGISTRY_V3_ADDRESS,
          twammAddress: process.env.TWAMM_ADDRESS,
          stakerAddress: process.env.STAKER_ADDRESS,
          governorAddress: process.env.GOVERNOR_ADDRESS,
          oracleAddress: process.env.ORACLE_ADDRESS,
          limitOrdersAddress: process.env.LIMIT_ORDERS_ADDRESS,
          splineLiquidityProviderAddress:
            process.env.SPLINE_LIQUIDITY_PROVIDER_ADDRESS,
        })
      : ([] as ReturnType<typeof createEventProcessors>);

  const filterConfig =
    process.env.NETWORK_TYPE === "evm"
      ? [
          {
            logs: evmProcessors.map((lp, ix) => ({
              id: ix + 1,
              address: lp.address,
              topics: lp.filter.topics,
              strict: lp.filter.strict,
            })),
          },
        ]
      : [
          {
            events: starknetProcessors.map((processor, ix) => ({
              id: ix + 1,
              address: processor.filter.fromAddress,
              keys: processor.filter.keys,
            })),
          },
        ];

  const streamClient =
    process.env.NETWORK_TYPE === "evm"
      ? createClient(EvmStream, process.env.APIBARA_URL, {
          defaultCallOptions: {
            "*": {
              metadata: Metadata({
                Authorization: `Bearer ${process.env.DNA_TOKEN}`,
              }),
            },
          },
        })
      : createClient(StarknetStream, process.env.APIBARA_URL, {
          defaultCallOptions: {
            "*": {
              metadata: Metadata({
                Authorization: `Bearer ${process.env.DNA_TOKEN}`,
              }),
            },
          },
        });

  for await (const message of streamClient.streamData({
    filter: filterConfig,
    finality: "accepted",
    startingCursor: currentCursor!,
    heartbeatInterval: {
      seconds: 10n,
      nanos: 0,
    },
  })) {
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
        logger.info({
          evt: "finalize",
          chainId,
          cursorOrderKey: message.finalize.cursor?.orderKey?.toString(),
          cursorUniqueKey: message.finalize.cursor?.uniqueKey?.toString(),
        });
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
          let eventsProcessed = 0;

          const blockNumber = Number(block.header.blockNumber);
          const blockTime = block.header.timestamp;
          const blockHashHex = block.header.blockHash ?? "0x0";

          await dao.begin(async (dao) => {
            await dao.deleteOldBlockNumbers(blockNumber);
            await dao.insertBlock({
              number: block.header.blockNumber,
              hash: BigInt(blockHashHex),
              time: blockTime,
            });

            if (process.env.NETWORK_TYPE === "evm") {
              const logs = (block as EvmBlock).logs;
              for (const log of logs) {
                const eventKey: EventKey = {
                  blockNumber,
                  transactionIndex: log.transactionIndex,
                  eventIndex: log.logIndexInTransaction,
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
            } else {
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
            lagMs,
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
                evt: "event-ingest-stats",
                blocks: statsBlocksProcessed,
                events: statsEventsInserted,
                durationMs: Math.round(statsProcessingTimeMs),
                eps: Number(eventsPerSecond.toFixed(2)),
                lagMs: lastObservedLagMs,
                catchupMsPerSec: Number(catchupMsPerSec.toFixed(2)),
                etaMs,
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
