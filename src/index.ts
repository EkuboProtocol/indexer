import "./config";
import type { EventKey } from "./_shared/eventKey.ts";
import { logger } from "./_shared/logger.ts";
import { DAO } from "./_shared/dao.ts";
import postgres from "postgres";
import { EvmStream } from "@apibara/evm";
import { StarknetStream } from "@apibara/starknet";
import { createLogProcessors } from "./evm/logProcessors.ts";
import { createEventProcessors } from "./starknet/eventProcessors.ts";
import { createClient, Metadata } from "@apibara/protocol";
import { msToHumanShort } from "./_shared/msToHumanShort.ts";

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

const sql = postgres(process.env.PG_CONNECTION_STRING, {
  connect_timeout: 1,
});

const dao = new DAO(sql, chainId);

// Timer for exiting if no blocks are received within the configured time
const NO_BLOCKS_TIMEOUT_MS = parseInt(process.env.NO_BLOCKS_TIMEOUT_MS || "0");
let noBlocksTimer: NodeJS.Timeout | null = null;

const FLUSH_EVERY = parseInt(process.env.FLUSH_EVERY_NUMBER || "100");

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
    const initializeTimer = logger.startTimer();
    databaseStartingCursor = await dao.initializeState();
    initializeTimer.done({
      message: "Prepared indexer state",
      startingCursor: databaseStartingCursor,
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

  let numberMessagesQueued: number = 0;
  let numberEventsQueued: number = 0;

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

          await dao.deleteOldBlockNumbers(
            Number(invalidatedCursor.orderKey) + 1
          );
          await dao.writeCursor(invalidatedCursor);
          await dao.flush();
          numberMessagesQueued = 0;
          numberEventsQueued = 0;
        }

        break;
      }

      case "data": {
        // Reset the no-blocks timer since we received block data
        resetNoBlocksTimer();

        const blockProcessingTimer = logger.startTimer();

        let eventsProcessed: number = 0;

        for (const block of message.data.data) {
          if (!block) continue;
          const blockNumber = Number(block.header.blockNumber);
          await dao.deleteOldBlockNumbers(blockNumber);

          const blockTime = block.header.timestamp;

          const blockHashHex = block.header.blockHash ?? "0x0";

          await dao.insertBlock({
            number: block.header.blockNumber,
            hash: BigInt(blockHashHex),
            time: blockTime,
          });

          if (process.env.NETWORK_TYPE === "evm") {
            const logs = ((block as any).logs ?? []) as Array<{
              filterIds?: readonly number[];
              topics: readonly `0x${string}`[];
              data: `0x${string}` | undefined;
              address: `0x${string}`;
              transactionIndex: number;
              logIndexInTransaction?: number;
              logIndex: number;
              transactionHash: `0x${string}`;
            }>;
            for (const log of logs) {
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
                (log.filterIds ?? []).map(async (matchingFilterId: number) => {
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
            const events = ((block as any).events ?? []) as Array<{
              filterIds?: readonly number[];
              transactionIndex: number;
              eventIndexInTransaction?: number;
              eventIndex: number;
              address: `0x${string}`;
              transactionHash: `0x${string}`;
              data?: readonly `0x${string}`[];
            }>;
            for (const event of events) {
              const eventKey: EventKey = {
                blockNumber,
                transactionIndex: event.transactionIndex,
                eventIndex: event.eventIndexInTransaction ?? event.eventIndex,
                emitter: event.address,
                transactionHash: event.transactionHash,
              };

              await Promise.all(
                (event.filterIds ?? []).map(
                  async (matchingFilterId: number) => {
                    eventsProcessed++;
                    const processor = starknetProcessors[matchingFilterId - 1]!;
                    const { value: parsed } = processor.parser(
                      event.data ?? [],
                      0
                    );
                    await processor.handle(dao, { key: eventKey, parsed });
                  }
                )
              );
            }
          }

          // endCursor is what we write so when we restart we delete any pending block information
          await dao.writeCursor(message.data.endCursor);

          numberMessagesQueued++;
          numberEventsQueued += eventsProcessed;

          if (
            message.data.production === "live" ||
            numberMessagesQueued % FLUSH_EVERY === 0
          ) {
            await dao.flush();
            numberMessagesQueued = 0;
            numberEventsQueued = 0;
          }

          blockProcessingTimer.done({
            chainId,
            blockNumber,
            numberMessagesQueued,
            numberEventsQueued,
            eventsProcessed,
            blockTimestamp: blockTime,
            lag: msToHumanShort(
              Math.floor(Date.now() - Number(blockTime.getTime()))
            ),
          });
        }

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
  })
  .finally(() => sql.end({ timeout: 5 }));
