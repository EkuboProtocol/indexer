import "./config";
import type { EventKey } from "./processor";
import { logger } from "./logger";
import { DAO } from "./dao";
import { Pool } from "pg";
import { EvmStream } from "@apibara/evm";
import { LOG_PROCESSORS } from "./evm/logProcessors.ts";
import { createClient, Metadata } from "@apibara/protocol";

const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING,
  connectionTimeoutMillis: 1000,
});

const streamClient = createClient(EvmStream, process.env.APIBARA_URL, {
  defaultCallOptions: {
    "*": {
      metadata: Metadata({
        Authorization: `Bearer ${process.env.DNA_TOKEN}`,
      }),
    },
  },
});

// Timer for exiting if no blocks are received within the configured time
const NO_BLOCKS_TIMEOUT_MS = parseInt(process.env.NO_BLOCKS_TIMEOUT_MS || "0");
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
          NO_BLOCKS_TIMEOUT_MS
        )}. Exiting process.`
      );
      process.exit(1);
    }, NO_BLOCKS_TIMEOUT_MS);
  }
}

function msToHumanShort(ms: number): string {
  const units = [
    { label: "d", ms: 86400000 },
    { label: "h", ms: 3600000 },
    { label: "min", ms: 60000 },
    { label: "s", ms: 1000 },
    { label: "ms", ms: 1 },
  ];

  const parts: string[] = [];

  for (const { label, ms: unitMs } of units) {
    if (ms >= unitMs) {
      const count = Math.floor(ms / unitMs);
      ms %= unitMs;
      parts.push(`${count}${label}`);
      if (parts.length === 3) break; // Limit to 2 components
    }
  }

  return parts.join(", ") || "0ms";
}

(async function () {
  const chainId = BigInt(process.env.CHAIN_ID);

  // first set up the schema
  let databaseStartingCursor;
  {
    const client = await pool.connect();
    const dao = new DAO(client, chainId, process.env.INDEXER_NAME);

    const initializeTimer = logger.startTimer();
    databaseStartingCursor = await dao.initializeState();
    await dao.refreshOperationalMaterializedView();
    initializeTimer.done({
      message: "Prepared indexer state",
      startingCursor: databaseStartingCursor,
    });
    client.release();
  }

  let lastIsHead = false;

  // Start the no-blocks timer when application starts
  resetNoBlocksTimer();

  for await (const message of streamClient.streamData({
    filter: [
      {
        logs: LOG_PROCESSORS.map((lp, ix) => ({
          id: ix + 1,
          address: lp.address,
          topics: lp.filter.topics,
          strict: lp.filter.strict,
        })),
      },
    ],
    finality: "accepted",
    startingCursor: databaseStartingCursor
      ? databaseStartingCursor
      : { orderKey: BigInt(process.env.STARTING_CURSOR_BLOCK_NUMBER ?? 0) },
    heartbeatInterval: {
      seconds: 10n,
      nanos: 0,
    },
  })) {
    switch (message._tag) {
      case "heartbeat": {
        logger.info(`Heartbeat`);

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

      case "invalidate": {
        let invalidatedCursor = message.invalidate.cursor;

        if (invalidatedCursor) {
          logger.warn(`Invalidated cursor`, {
            cursor: invalidatedCursor,
          });

          const client = await pool.connect();
          const dao = new DAO(client, chainId, process.env.INDEXER_NAME);

          await dao.beginTransaction();
          await dao.deleteOldBlockNumbers(
            Number(invalidatedCursor.orderKey) + 1
          );
          await dao.writeCursor(invalidatedCursor);
          await dao.commitTransaction();

          client.release();
        }

        break;
      }

      case "data": {
        // Reset the no-blocks timer since we received block data
        resetNoBlocksTimer();

        const blockProcessingTimer = logger.startTimer();

        const client = await pool.connect();
        const dao = new DAO(client, chainId, process.env.INDEXER_NAME);

        await dao.beginTransaction();

        let deletedCount: number = 0;

        let eventsProcessed: number = 0;
        const isHead = message.data.production === "live";

        for (const block of message.data.data) {
          if (!block) continue;
          const blockNumber = Number(block.header.blockNumber);
          deletedCount += await dao.deleteOldBlockNumbers(blockNumber);

          const blockTime = block.header.timestamp;

          await dao.insertBlock({
            number: block.header.blockNumber,
            hash: BigInt(block.header.blockHash ?? 0),
            time: blockTime,
          });

          for (const event of block.logs) {
            const eventKey: EventKey = {
              blockNumber,
              transactionIndex: event.transactionIndex,
              eventIndex: event.logIndexInTransaction,
              emitter: event.address,
              transactionHash: event.transactionHash,
            };

            // process each event sequentially through all the event processors in parallel
            // assumption is that none of the event processors operate on the same events, i.e. have the same filters
            // this assumption could be validated at runtime
            await Promise.all(
              event.filterIds.map(async (matchingFilterId) => {
                eventsProcessed++;

                await LOG_PROCESSORS[matchingFilterId - 1].handler(
                  dao,
                  eventKey,
                  {
                    topics: event.topics,
                    data: event.data,
                  }
                );
              })
            );
          }

          // endCursor is what we write so when we restart we delete any pending block information
          await dao.writeCursor(message.data.endCursor);

          const refreshOperational =
            (isHead && (eventsProcessed > 0 || !lastIsHead)) ||
            deletedCount > 0;

          // refresh operational views at the end of the batch
          if (refreshOperational) {
            await dao.refreshOperationalMaterializedView();
          }

          await dao.commitTransaction();

          blockProcessingTimer.done({
            message: `Processed to block`,
            blockNumber,
            isHead,
            refreshOperational,
            eventsProcessed,
            blockTimestamp: blockTime,
            lag: msToHumanShort(
              Math.floor(Date.now() - Number(blockTime.getTime()))
            ),
          });
        }

        client.release();

        lastIsHead = isHead;

        break;
      }

      default: {
        logger.error(`Unhandled message type: ${message._tag}`);
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
  });
