import "./config";
import type { EventKey } from "./eventKey.ts";
import { logger } from "./logger";
import { DAO } from "./dao";
import { Pool } from "pg";
import { EvmStream } from "@apibara/evm";
import { StarknetStream } from "@apibara/starknet";
import { createLogProcessors } from "./evm/logProcessors.ts";
import { createEventProcessors } from "./starknet/eventProcessors.ts";
import { createClient, Metadata } from "@apibara/protocol";
import { msToHumanShort } from "./msToHumanShort.ts";

if (!["starknet", "evm"].includes(process.env.NETWORK_TYPE)) {
  throw new Error(`Invalid NETWORK_TYPE: "${process.env.NETWORK_TYPE}"`);
}

if (!process.env.NETWORK) {
  throw new Error(`Missing NETWORK`);
}

if (!process.env.INDEXER_NAME) {
  throw new Error("Missing INDEXER_NAME");
}

const chainId = BigInt(process.env.CHAIN_ID);

if (!chainId) {
  throw new Error("Missing CHAIN_ID");
}

const indexerName = process.env.INDEXER_NAME;
if (!indexerName) {
  throw new Error("Missing INDEXER_NAME");
}

const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING,
  connectionTimeoutMillis: 1000,
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

(async function () {
  // first set up the schema
  let databaseStartingCursor;
  {
    const client = await pool.connect();
    const dao = new DAO(client, chainId, indexerName);

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

  const evmProcessors =
    process.env.NETWORK_TYPE === "evm"
      ? createLogProcessors({
          mevResistAddress: process.env.MEV_RESIST_ADDRESS,
          coreAddress: process.env.CORE_ADDRESS,
          positionsAddress: process.env.POSITIONS_ADDRESS,
          oracleAddress: process.env.ORACLE_ADDRESS,
          twammAddress: process.env.TWAMM_ADDRESS,
          ordersAddress: process.env.ORDERS_ADDRESS,
          incentivesAddress: process.env.INCENTIVES_ADDRESS,
          tokenWrapperFactoryAddress: process.env.TOKEN_WRAPPER_FACTORY_ADDRESS,
        })
      : undefined;

  const starknetProcessors =
    process.env.NETWORK_TYPE === "starknet"
      ? createEventProcessors({
          positionsAddress: process.env.POSITIONS_ADDRESS,
          nftAddress: process.env.NFT_ADDRESS,
          coreAddress: process.env.CORE_ADDRESS,
          tokenRegistryAddress: process.env.TOKEN_REGISTRY_ADDRESS,
          tokenRegistryV2Address: process.env.TOKEN_REGISTRY_V2_ADDRESS,
          tokenRegistryV3Address: process.env.TOKEN_REGISTRY_V3_ADDRESS,
          twammAddress: process.env.TWAMM_ADDRESS,
          stakerAddress: process.env.STAKER_ADDRESS as `0x${string}`,
          governorAddress: process.env.GOVERNOR_ADDRESS as `0x${string}`,
          oracleAddress: process.env.ORACLE_ADDRESS as `0x${string}`,
          limitOrdersAddress: process.env.LIMIT_ORDERS_ADDRESS,
          splineLiquidityProviderAddress: process.env
            .SPLINE_LIQUIDITY_PROVIDER_ADDRESS as `0x${string}`,
        })
      : undefined;

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

          const blockHashHex = (block.header.blockHash ??
            "0x0") as `0x${string}`;

          await dao.insertBlock({
            number: block.header.blockNumber,
            hash: BigInt(blockHashHex),
            time: blockTime,
          });

          if (process.env.NETWORK_TYPE === "evm") {
            for (const log of block.logs) {
              const eventKey: EventKey = {
                blockNumber,
                transactionIndex: log.transactionIndex,
                eventIndex:
                  log.logIndexInTransaction ??
                  // fallback to block-level index if transaction-scoped index missing
                  log.logIndex,
                emitter: log.address,
                transactionHash: log.transactionHash,
              };

              await Promise.all(
                (log.filterIds ?? []).map(async (matchingFilterId) => {
                  eventsProcessed++;

                  await evmProcessors[matchingFilterId - 1].handler(
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
            for (const event of block.events) {
              const eventKey: EventKey = {
                blockNumber,
                transactionIndex: event.transactionIndex,
                eventIndex: event.eventIndexInTransaction ?? event.eventIndex,
                emitter: event.address,
                transactionHash: event.transactionHash,
              };

              await Promise.all(
                (event.filterIds ?? []).map(async (matchingFilterId) => {
                  eventsProcessed++;
                  const processor = starknetProcessors[matchingFilterId - 1];
                  const { value: parsed } = processor.parser(
                    event.data ?? [],
                    0
                  );
                  await processor.handle(dao, { key: eventKey, parsed });
                })
              );
            }
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
