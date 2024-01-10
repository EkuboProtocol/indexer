import "./config";
import {
  FieldElement,
  Filter,
  StarkNetCursor,
  v1alpha2 as starknet,
} from "@apibara/starknet";
import { Cursor, StreamClient, v1alpha2 } from "@apibara/protocol";
import { EventKey, eventKeyToId, ParsedEventWithKey } from "./processor";
import { logger } from "./logger";
import { DAO } from "./dao";
import { Pool } from "pg";
import { throttle } from "tadaaa";
import { positionsContract } from "./positions";
import { EVENT_PROCESSORS } from "./EVENT_PROCESSORS";
import PQueue from "p-queue-cjs";
import {
  ProtocolFeesPaidEvent,
  PositionFeesCollectedEvent,
} from "./events/core";

const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING,
  connectionTimeoutMillis: 1000,
});

const streamClient = new StreamClient({
  url: process.env.APIBARA_URL,
  token: process.env.APIBARA_AUTH_TOKEN,
});

export function parseLong(long: number | Long): bigint {
  return BigInt(typeof long === "number" ? long : long.toNumber());
}

const refreshAnalyticalViews = throttle(
  async function () {
    const timer = logger.startTimer();
    logger.info("Started refreshing analytical views", { start: timer.start });
    const client = await pool.connect();
    const dao = new DAO(client);
    await dao.refreshAnalyticalMaterializedViews();
    client.release();
    timer.done({ message: "Refreshed analytical views" });
  },
  {
    delay: parseInt(process.env.REFRESH_RATE_ANALYTICAL_VIEWS),
    leading: true,
    async onError(err) {
      logger.error("Failed to refresh analytical views", err);
    },
  }
);

const MAX_POSTGRES_SMALLINT = 32767;

const refreshLeaderboard = throttle(
  async function () {
    const timer = logger.startTimer();

    logger.info("Started refreshing leaderboard", {
      start: timer.start,
    });

    const client = await pool.connect();

    const { rows: latestBlockNumberRows } = await client.query<{
      id: string;
      block_number: number;
      transaction_index: number;
    }>(`
        SELECT id, block_number, transaction_index
        FROM event_keys
        WHERE block_number != (SELECT block_number FROM event_keys ORDER BY id DESC LIMIT 1)
        ORDER BY id DESC
        LIMIT 1
    `);

    if (!latestBlockNumberRows.length) {
      logger.info("Not refreshing leaderboard because there are no events");
      return;
    }
    const [
      { id: latestEventId, block_number: blockNumber, transaction_index },
    ] = latestBlockNumberRows;

    logger.debug("Leaderboard refresh starting at block number", {
      latestEventId,
      blockNumber,
    });

    // get all the active positions
    const { rows: positions } = await client.query<{
      token_id: string;
      owner: string;
      token0: string;
      token1: string;
      fee: string;
      tick_spacing: number;
      extension: string;
      lower_bound: number;
      upper_bound: number;
    }>(`
        WITH initial_transfers AS (SELECT token_id FROM position_transfers WHERE from_address = 0 AND to_address != 0),
             positions_minted AS (SELECT token_id, owner, pool_key_hash, lower_bound, upper_bound
                                  FROM initial_transfers
                                           JOIN LATERAL (
                                      SELECT to_address AS owner
                                      FROM position_transfers AS pt
                                      WHERE pt.token_id = initial_transfers.token_id
                                        AND event_id <= ${latestEventId}
                                      ORDER BY event_id DESC
                                      LIMIT 1
                                      ) AS position_owners ON TRUE
                                           JOIN LATERAL (
                                      SELECT pool_key_hash, lower_bound, upper_bound
                                      FROM position_updates AS pu
                                      WHERE pu.locker = ${BigInt(
                                        positionsContract.address
                                      )}
                                        AND token_id::NUMERIC = pu.salt
                                      ORDER BY event_id DESC
                                      LIMIT 1
                                      ) AS mint_parameters ON TRUE
                                  WHERE owner != 0)
        SELECT token_id,
               owner,
               token0,
               token1,
               fee,
               tick_spacing,
               extension,
               lower_bound,
               upper_bound
        FROM positions_minted AS pm
                 JOIN pool_keys AS pk ON pm.pool_key_hash = pk.key_hash
        WHERE owner != 0
    `);

    logger.info(
      `Leaderboard: getting position information for ${positions.length} positions`
    );

    const CHUNK_SIZE = 200;

    const getTokenInfoRequestChunks = Array(
      Math.ceil(positions.length / CHUNK_SIZE)
    )
      .fill(null)
      .map((_, ix) => {
        return positions
          .slice(ix * CHUNK_SIZE, ix * CHUNK_SIZE + CHUNK_SIZE)
          .map((p) => ({
            id: BigInt(p.token_id),
            pool_key: {
              token0: BigInt(p.token0),
              token1: BigInt(p.token1),
              fee: BigInt(p.fee),
              tick_spacing: p.tick_spacing,
              extension: BigInt(p.extension),
            },
            bounds: {
              lower: {
                mag: Math.abs(p.lower_bound),
                sign: p.lower_bound < 0,
              },
              upper: {
                mag: Math.abs(p.upper_bound),
                sign: p.upper_bound < 0,
              },
            },
          }));
      });

    logger.info(
      `Leaderboard query needs ${getTokenInfoRequestChunks.length} chunks at block number ${blockNumber}`
    );

    const queue = new PQueue({ concurrency: 20 });

    const fivePercentMarker = Math.ceil(getTokenInfoRequestChunks.length / 20);

    const allPositionTokenInfos = await Promise.all(
      getTokenInfoRequestChunks.map((getTokenInfoRequests, ix) =>
        queue.add(() => {
          if (ix !== 0 && ix % fivePercentMarker === 0) {
            logger.info(
              `Leaderboard: ${Math.round(
                (ix / getTokenInfoRequestChunks.length) * 100
              )}% complete fetching state`
            );
          }

          return positionsContract.call(
            "get_tokens_info",
            [getTokenInfoRequests],
            {
              blockIdentifier: blockNumber,
            }
          );
        })
      )
    );

    logger.info(`Positions state fetched, starting leaderboard table refresh`);

    const transactionHash = 0n;
    let transactionIndex = transaction_index + 1;
    let nextEventIndex = 0;

    function nextEventKey() {
      if (nextEventIndex >= MAX_POSTGRES_SMALLINT) {
        nextEventIndex = 0;
        transactionIndex++;
      }
      if (transactionIndex >= MAX_POSTGRES_SMALLINT) {
        throw new Error("Event key too large");
      }
      return {
        transactionIndex,
        blockNumber,
        transactionHash,
        eventIndex: nextEventIndex++,
      };
    }

    const { feeWithdrawnEvents, protocolFeesPaidEvents } =
      allPositionTokenInfos.reduce<{
        feeWithdrawnEvents: ParsedEventWithKey<PositionFeesCollectedEvent>[];
        protocolFeesPaidEvents: ParsedEventWithKey<ProtocolFeesPaidEvent>[];
      }>(
        (
          memo,
          tokenInfos: {
            amount0: bigint;
            amount1: bigint;
            fees0: bigint;
            fees1: bigint;
          }[],
          chunkIx
        ) => {
          tokenInfos.forEach(({ fees0, fees1, amount0, amount1 }, ix) => {
            const position = positions[chunkIx * 200 + ix];
            const pool_key = {
              token0: BigInt(position.token0),
              token1: BigInt(position.token1),
              fee: BigInt(position.fee),
              tick_spacing: BigInt(position.tick_spacing),
              extension: BigInt(position.extension),
            };
            const position_key = {
              bounds: {
                lower: BigInt(position.lower_bound),
                upper: BigInt(position.lower_bound),
              },
              owner: BigInt(positionsContract.address),
              salt: BigInt(position.token_id),
            };

            if (fees0 > 0n || fees1 > 0n) {
              memo.feeWithdrawnEvents.push({
                parsed: {
                  pool_key,
                  position_key,
                  delta: {
                    amount0: -fees0,
                    amount1: -fees1,
                  },
                },
                key: nextEventKey(),
              });
            }

            if (amount0 > 0n || amount1 > 0n) {
              const protocolFees0 = (amount0 * pool_key.fee) / (1n << 128n);
              const protocolFees1 = (amount1 * pool_key.fee) / (1n << 128n);
              if (protocolFees0 > 0n || protocolFees1 > 0n)
                memo.protocolFeesPaidEvents.push({
                  parsed: {
                    pool_key,
                    position_key,
                    delta: {
                      amount0: -protocolFees0,
                      amount1: -protocolFees1,
                    },
                  },
                  key: nextEventKey(),
                });
            }
          });
          return memo;
        },
        {
          feeWithdrawnEvents: [],
          protocolFeesPaidEvents: [],
        }
      );

    const dao = new DAO(client);

    await dao.beginTransaction();

    await dao.batchInsertFakeFeeEvents(
      "position_fees_collected",
      BigInt(positionsContract.address),
      feeWithdrawnEvents
    );

    await dao.batchInsertFakeFeeEvents(
      "protocol_fees_paid",
      BigInt(positionsContract.address),
      protocolFeesPaidEvents
    );

    logger.info(
      `Inserted ${feeWithdrawnEvents.length} phantom fee withdrawal events and ${protocolFeesPaidEvents.length} protocol fees paid events`
    );

    await dao.refreshLeaderboard(eventKeyToId(nextEventKey()));

    await dao.deleteFakeEvents(blockNumber);

    logger.info(`Cleared fake events`);

    await dao.commitTransaction();

    client.release();

    timer.done({ message: "Refreshed leaderboard" });
  },
  {
    delay: parseInt(process.env.REFRESH_RATE_LEADERBOARD),
    leading: true,
    async onError(err) {
      logger.error("Failed to refresh leaderboard", err);
    },
  }
);

(async function () {
  // first set up the schema
  let databaseStartingCursor;
  {
    const client = await pool.connect();
    databaseStartingCursor = await new DAO(client).initializeSchema();
    client.release();
  }

  logger.info(`Initialized`, {
    startingCursor: databaseStartingCursor,
  });

  streamClient.configure({
    filter: EVENT_PROCESSORS.reduce((memo, value) => {
      return memo.addEvent((ev) =>
        ev
          .withKeys(value.filter.keys)
          .withIncludeReceipt(true)
          .withFromAddress(value.filter.fromAddress)
      );
    }, Filter.create().withHeader({ weak: true })).encode(),
    batchSize: 1,
    finality: v1alpha2.DataFinality.DATA_STATUS_PENDING,
    cursor: databaseStartingCursor
      ? Cursor.fromObject(databaseStartingCursor)
      : StarkNetCursor.createWithBlockNumber(
          Number(process.env.STARTING_CURSOR_BLOCK_NUMBER ?? 0)
        ),
  });

  for await (const message of streamClient) {
    let messageType = !!message.heartbeat
      ? "heartbeat"
      : !!message.invalidate
      ? "invalidate"
      : !!message.data
      ? "data"
      : "unknown";

    switch (messageType) {
      case "data": {
        if (!message.data.data) {
          logger.error(`Data message is empty`);
          break;
        } else {
          const blockProcessingTimer = logger.startTimer();

          const client = await pool.connect();
          const dao = new DAO(client);

          await dao.beginTransaction();

          let isPending: boolean = false;

          let deletedCount: number = 0;

          for (const encodedBlockData of message.data.data) {
            const block = starknet.Block.decode(encodedBlockData);

            const blockNumber = Number(parseLong(block.header.blockNumber));
            deletedCount += await dao.deleteOldBlockNumbers(blockNumber);

            // for pending blocks we update operational materialized views before we commit
            isPending =
              isPending || FieldElement.toBigInt(block.header.blockHash) === 0n;

            const blockTime = new Date(
              Number(parseLong(block.header.timestamp.seconds) * 1000n)
            );
            await dao.insertBlock({
              hash: FieldElement.toBigInt(block.header.blockHash),
              number: parseLong(block.header.blockNumber),
              time: blockTime,
            });

            for (const { event, transaction, receipt } of block.events) {
              const eventKey: EventKey = {
                blockNumber,
                transactionHash: FieldElement.toBigInt(transaction.meta.hash),
                transactionIndex: Number(parseLong(receipt.transactionIndex)),
                eventIndex: Number(parseLong(event.index)),
              };

              // process each event sequentially through all the event processors in parallel
              // assumption is that none of the event processors operate on the same events, i.e. have the same filters
              // this assumption could be validated at runtime
              await Promise.all(
                EVENT_PROCESSORS.map(async ({ parser, handle, filter }) => {
                  if (
                    FieldElement.toBigInt(event.fromAddress) ===
                      FieldElement.toBigInt(filter.fromAddress) &&
                    event.keys.length === filter.keys.length &&
                    event.keys.every(
                      (key, ix) =>
                        FieldElement.toBigInt(key) ===
                        FieldElement.toBigInt(filter.keys[ix])
                    )
                  ) {
                    const parsed = parser(event.data, 0).value;

                    await handle(dao, {
                      parsed: parsed as any,
                      key: eventKey,
                    });
                  }
                })
              );
            }

            await dao.writeCursor(Cursor.toObject(message.data.cursor));

            // refresh operational views at the end of the batch
            if (isPending || deletedCount > 0) {
              await dao.refreshOperationalMaterializedView();
            }

            await dao.commitTransaction();

            blockProcessingTimer.done({
              message: `Processed to block`,
              blockNumber,
              isPending,
              blockTimestamp: blockTime,
              lagMilliseconds: Math.floor(
                Date.now() - Number(blockTime.getTime())
              ),
            });
          }

          client.release();

          if (isPending) {
            refreshAnalyticalViews();
            refreshLeaderboard();
          }
        }

        break;
      }

      case "heartbeat": {
        logger.info(`Heartbeat`);
        break;
      }

      case "invalidate": {
        let invalidatedCursor = Cursor.toObject(message.invalidate.cursor);

        logger.warn(`Invalidated cursor`, {
          cursor: invalidatedCursor,
        });

        const client = await pool.connect();
        const dao = new DAO(client);

        await dao.beginTransaction();
        await dao.deleteOldBlockNumbers(Number(invalidatedCursor.orderKey) + 1);
        await dao.writeCursor(Cursor.toObject(message.invalidate.cursor));
        await dao.commitTransaction();

        client.release();
        break;
      }

      case "unknown": {
        logger.error(`Unknown message type`);
        break;
      }
    }
  }
})()
  .then(() => {
    logger.info("Stream closed gracefully");
  })
  .catch((error) => {
    logger.error(error);
    process.exit(1);
  });
