import "./config";
import { logger } from "./_shared/logger";
import { DAO, type IndexerCursor } from "./_shared/dao";
import { Block as EvmBlock } from "@apibara/evm";
import { Block as StarknetBlock } from "@apibara/starknet";
import { msToHumanShort } from "./_shared/msToHumanShort";
import {
  createEvmEntrypoint,
  isEvmBlock,
} from "./entrypoints/evm";
import {
  createStarknetEntrypoint,
  isStarknetBlock,
} from "./entrypoints/starknet";
import {
  isNetworkTypeValid,
  type NetworkEntrypoint,
} from "./entrypoints/types";

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

type SelectedEntrypoint =
  | {
      networkType: "evm";
      entrypoint: NetworkEntrypoint<EvmBlock>;
      isBlock: typeof isEvmBlock;
    }
  | {
      networkType: "starknet";
      entrypoint: NetworkEntrypoint<StarknetBlock>;
      isBlock: typeof isStarknetBlock;
    };

// Timer for exiting if no blocks are received within the configured time
const NO_BLOCKS_TIMEOUT_MS = parseInt(process.env.NO_BLOCKS_TIMEOUT_MS || "0");
let noBlocksTimer: NodeJS.Timeout | null = null;

const statsBlockIntervalRaw = parseInt(
  process.env.EVENT_STATS_BLOCK_INTERVAL || "100",
  10,
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
          2,
        )}. Exiting process.`,
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
    const expectedCursor = { orderKey: 0n };
    let initializedCursor: IndexerCursor | null = null;

    currentCursor = await dao.begin(async (dao) => {
      const databaseStartingCursor = await dao.loadCursor();
      if (databaseStartingCursor) {
        return databaseStartingCursor;
      } else {
        initializedCursor = await dao.writeCursor(
          {
            orderKey: BigInt(process.env.STARTING_CURSOR_BLOCK_NUMBER!),
          },
          // should never happen but so this will cause it to revert if there's a race condition
          expectedCursor,
        );
        return initializedCursor;
      }
    });

    initializeTimer.done({
      message: "Prepared indexer state",
      startingCursor: currentCursor,
      expectedCursor: initializedCursor ? expectedCursor : null,
      writtenCursor: initializedCursor,
    });
  }

  // Start the no-blocks timer when application starts
  resetNoBlocksTimer();

  const selectedEntrypoint: SelectedEntrypoint =
    NETWORK_TYPE === "evm"
      ? {
          networkType: "evm",
          entrypoint: await createEvmEntrypoint(chainId),
          isBlock: isEvmBlock,
        }
      : {
          networkType: "starknet",
          entrypoint: createStarknetEntrypoint(),
          isBlock: isStarknetBlock,
        };

  // Retry loop: if the stored cursor is no longer canonical (e.g. due to an
  // unhandled reorg on a previous run), reset it to the last finalized cursor
  // and restart the stream. Limit retries to avoid infinite loops.
  const MAX_REORG_RETRIES = 3;
  let reorgRetries = 0;
  while (true) {
    const streamOptions = {
      finality: "accepted",
      startingCursor: currentCursor!,
      heartbeatInterval: {
        seconds: 10n,
        nanos: 0n,
      },
    } as const;

    const stream = selectedEntrypoint.entrypoint.createStream(streamOptions);

    try {
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
              const expectedCursor = currentCursor;
              await dao.updateFinalizedCursor(expectedCursor, finalizedCursor);

              logger.info({
                evt: "finalize",
                chainId,
                finalizedCursor,
                expectedCursor,
              });
            }

            break;
          }

          case "invalidate": {
            const invalidatedCursor = message.invalidate.cursor;
            if (!invalidatedCursor)
              throw new Error("invalidate message missing a cursor");

            if (invalidatedCursor) {
              let writtenCursor: IndexerCursor | null = null;
              const expectedCursor = currentCursor;

              await dao.begin(async (dao) => {
                await dao.deleteOldBlockNumbers(
                  Number(invalidatedCursor.orderKey) + 1,
                );
                currentCursor = await dao.writeCursor(
                  invalidatedCursor,
                  expectedCursor,
                );
                writtenCursor = currentCursor;
              });

              logger.warn(`Cursor invalidated`, {
                invalidatedCursor,
                expectedCursor,
                writtenCursor,
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
              const expectedCursor = currentCursor;
              let writtenCursor: IndexerCursor | null = null;

              const blockNumber = Number(block.header.blockNumber);
              const blockTime = block.header.timestamp;

              if (!selectedEntrypoint.isBlock(block)) {
                throw new Error(
                  `Received unexpected block type for ${selectedEntrypoint.networkType}`,
                );
              }

              const plannedEvents =
                selectedEntrypoint.entrypoint.getPlannedEvents(block);

              let eventsProcessed = 0;

              await dao.begin(async (dao) => {
                await dao.deleteOldBlockNumbers(blockNumber);

                const blockHashHex = block.header.blockHash ?? "0x0";
                let baseFeePerGas: bigint | null = null;

                if (
                  "baseFeePerGas" in block.header &&
                  block.header.baseFeePerGas
                ) {
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

                eventsProcessed =
                  await selectedEntrypoint.entrypoint.processBlock({
                    block,
                    blockNumber,
                    dao,
                  });

                // endCursor is what we write so when we restart we delete any pending block information
                currentCursor = await dao.writeCursor(
                  endCursor,
                  expectedCursor,
                );
                writtenCursor = currentCursor;
              });

              const nowMs = Date.now();
              const lagMs = Math.max(0, nowMs - Number(blockTime.getTime()));

              blockProcessingTimer.done({
                bNo: blockNumber,
                bTs: blockTime,
                evts: eventsProcessed,
                lag: msToHumanShort(lagMs, 2),
                expectedCursor,
                writtenCursor,
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

      // Stream ended gracefully; exit the retry loop
      break;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Starting cursor is not canonical")
      ) {
        if (reorgRetries >= MAX_REORG_RETRIES) {
          throw new Error(
            `Cursor is not canonical and max retries (${MAX_REORG_RETRIES}) exceeded: ${error.message}`,
            { cause: error },
          );
        }
        const finalizedCursor = await dao.loadFinalizedCursor();
        if (finalizedCursor) {
          reorgRetries++;
          const expectedCursor = currentCursor;
          let writtenCursor: IndexerCursor | null = null;
          await dao.begin(async (dao) => {
            await dao.deleteOldBlockNumbers(
              Number(finalizedCursor.orderKey) + 1,
            );
            currentCursor = await dao.writeCursor(
              finalizedCursor,
              expectedCursor,
            );
            writtenCursor = currentCursor;
          });
          logger.warn(
            "Cursor is not canonical, resetting to last finalized cursor",
            { expectedCursor, finalizedCursor, writtenCursor, reorgRetries },
          );
          continue;
        } else {
          throw new Error(
            `Cursor is not canonical and no finalized cursor is available to recover to. Manual intervention may be required. Original error: ${error.message}`,
            { cause: error },
          );
        }
      }
      throw error;
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
