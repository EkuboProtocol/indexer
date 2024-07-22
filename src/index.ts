import "./config";
import { FieldElement, Filter, StarknetStream } from "@apibara/starknet";
import { Cursor, createClient } from "@apibara/protocol";
import { EventKey } from "./processor";
import { logger } from "./logger";
import { DAO } from "./dao";
import { Pool } from "pg";
import { throttle } from "tadaaa";
import { EVENT_PROCESSORS } from "./EVENT_PROCESSORS";

const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING,
  connectionTimeoutMillis: 1000,
});

const streamClient = createClient(StarknetStream, process.env.APIBARA_URL);

export function parseLong(long: number): bigint {
  return BigInt(typeof long === "number" ? long : long.toNumber());
}

const refreshAnalyticalTables = throttle(
  async function (
    since: Date = new Date(
      Date.now() - parseInt(process.env.REFRESH_RATE_ANALYTICAL_VIEWS) * 2
    )
  ) {
    const timer = logger.startTimer();
    logger.info("Started refreshing analytical tables", {
      start: timer.start,
      since: since.toISOString(),
    });
    const client = await pool.connect();
    const dao = new DAO(client);
    await dao.beginTransaction();
    await dao.refreshAnalyticalTables({
      since,
    });
    await dao.commitTransaction();
    client.release();
    timer.done({
      message: "Refreshed analytical tables",
      since: since.toISOString(),
    });
  },
  {
    delay: parseInt(process.env.REFRESH_RATE_ANALYTICAL_VIEWS),
    leading: true,
    async onError(err) {
      logger.error("Failed to refresh analytical tables", err);
    },
  }
);

(async function () {
  {
    const status = await streamClient.status();
    console.log(status);
  }

  // first set up the schema
  let databaseStartingCursor;
  {
    const client = await pool.connect();
    const dao = new DAO(client);

    const initializeTimer = logger.startTimer();
    databaseStartingCursor = await dao.initializeSchema();
    initializeTimer.done({
      message: "Initialized schema",
      startingCursor: databaseStartingCursor,
    });
    client.release();
  }

  refreshAnalyticalTables(new Date(0));

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

            const transactionSenders: {
              [transactionHash: string]: string;
            } = {};

            const transactionReceipts: {
              [transactionHash: string]: {
                feePaid: bigint;
                feePaidUnit: starknet.PriceUnit;
              };
            } = {};

            for (const { event, transaction, receipt } of block.events) {
              const eventKey: EventKey = {
                blockNumber,
                transactionIndex: Number(parseLong(receipt.transactionIndex)),
                eventIndex: Number(parseLong(event.index)),
                fromAddress: FieldElement.toBigInt(event.fromAddress),
                transactionHash: FieldElement.toBigInt(transaction.meta.hash),
              };

              const rawSender =
                transaction?.invokeV1?.senderAddress ??
                transaction.invokeV3?.senderAddress ??
                transaction?.invokeV0?.contractAddress ??
                transaction?.declare?.senderAddress;

              const senderHex = rawSender
                ? FieldElement.toHex(rawSender)
                : null;

              const feePaid = FieldElement.toBigInt(
                receipt.actualFee ?? receipt.actualFeePaid?.amount
              );
              const feePaidUnit =
                receipt.actualFeePaid?.unit ??
                starknet.PriceUnit.PRICE_UNIT_UNSPECIFIED;

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
                    const transactionMapKey =
                      eventKey.transactionHash.toString();
                    if (senderHex) {
                      transactionSenders[transactionMapKey] = senderHex;
                    }

                    transactionReceipts[transactionMapKey] =
                      transactionReceipts[transactionMapKey] ?? {
                        feePaid,
                        feePaidUnit,
                      };

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

            await dao.writeTransactionSenders(
              Object.entries(transactionSenders)
            );

            await dao.writeReceipts(Object.entries(transactionReceipts));

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
            refreshAnalyticalTables();
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
