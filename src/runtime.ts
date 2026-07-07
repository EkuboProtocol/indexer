import { logger } from "./_shared/logger";
import { DAO, type IndexerCursor } from "./_shared/dao";
import { msToHumanShort } from "./_shared/msToHumanShort";
import { loadConfig } from "./config";
import type { NetworkEntrypoint, NetworkType } from "./types";

export type RuntimeBlockHeader = {
  number: number;
  hash: bigint;
  timestamp: number;
  baseFeePerGas: bigint | null;
};

export type ParsedRuntimeBlock<TBlock> = {
  block: TBlock;
  header: RuntimeBlockHeader;
};

type RuntimeEntrypoint<TBlock> = {
  networkType: NetworkType;
  createEntrypoint(
    chainId: bigint,
  ): Promise<NetworkEntrypoint<TBlock>> | NetworkEntrypoint<TBlock>;
  parseBlockHeader(block: unknown): ParsedRuntimeBlock<TBlock> | null;
};

export async function runIndexer<TBlock>({
  networkType,
  createEntrypoint,
  parseBlockHeader,
}: RuntimeEntrypoint<TBlock>) {
  loadConfig(networkType);

  if (!process.env.NETWORK) {
    throw new Error(`Missing NETWORK`);
  }

  const chainId = BigInt(process.env.CHAIN_ID!);

  if (!chainId) {
    throw new Error("Missing CHAIN_ID");
  }

  const dao = DAO.create(process.env.PG_CONNECTION_STRING!, chainId);

  // Timer for exiting if no blocks are received within the configured time
  const NO_BLOCKS_TIMEOUT_MS = parseInt(
    process.env.NO_BLOCKS_TIMEOUT_MS || "0",
  );
  let noBlocksTimer: NodeJS.Timeout | null = null;

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

  return (async function () {
    logger.info({ message: `Acquiring lock for chain ID ${chainId}` });
    const lockTimer = logger.startTimer();
    await dao.acquireLock();
    lockTimer.done({ message: `Acquired lock for chain ID ${chainId}` });

    const entrypoint = await createEntrypoint(chainId);

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
          nanos: 0,
        },
      } as const;

      const stream = entrypoint.createStream(streamOptions);

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
                  logger.error(
                    `System message: ${message.systemMessage.output}`,
                  );
                  break;
                case "stdout":
                  logger.info(
                    `System message: ${message.systemMessage.output}`,
                  );
                  break;
              }
              break;
            }

            case "finalize": {
              const finalizedCursor = message.finalize.cursor;

              if (finalizedCursor) {
                const expectedCursor = currentCursor;
                await dao.updateFinalizedCursor(
                  expectedCursor,
                  finalizedCursor,
                );

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

                const parsedBlock = parseBlockHeader(block);
                if (!parsedBlock) {
                  throw new Error(
                    `Received unexpected block type for ${networkType}`,
                  );
                }

                const blockProcessingTimer = logger.startTimer();
                const expectedCursor = currentCursor;
                let writtenCursor: IndexerCursor | null = null;

                const blockNumber = parsedBlock.header.number;
                const blockTime = new Date(parsedBlock.header.timestamp);

                const plannedEvents = entrypoint.getPlannedEvents(
                  parsedBlock.block,
                );

                let eventsProcessed = 0;

                await dao.begin(async (dao) => {
                  await dao.deleteOldBlockNumbers(blockNumber);

                  await dao.insertBlock({
                    number: parsedBlock.header.number,
                    hash: parsedBlock.header.hash,
                    time: blockTime,
                    baseFeePerGas: parsedBlock.header.baseFeePerGas,
                    numEvents: plannedEvents,
                  });

                  eventsProcessed = await entrypoint.processBlock({
                    block: parsedBlock.block,
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
                const lagMs = Math.max(0, nowMs - parsedBlock.header.timestamp);

                blockProcessingTimer.done({
                  bNo: blockNumber,
                  bTs: blockTime,
                  evts: eventsProcessed,
                  lag: msToHumanShort(lagMs, 2),
                  expectedCursor,
                  writtenCursor,
                });
              }

              break;
            }

            default: {
              logger.error("Unhandled message type", message);
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
}
