import "./config";
import { Filter, StarknetStream } from "@apibara/starknet";
import { createClient } from "@apibara/protocol";
import { EventKey } from "./processor";
import { logger } from "./logger";
import { DAO } from "./dao";
import { Pool } from "pg";
import { throttle } from "tadaaa";
import { EVENT_PROCESSORS } from "./EVENT_PROCESSORS";
import Long from "long";

const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING,
  connectionTimeoutMillis: 1000,
});

const streamClient = createClient(StarknetStream, process.env.APIBARA_URL);

export function parseLong(long: number | Long): bigint {
  return BigInt(typeof long === "number" ? long : long.toNumber());
}

const refreshAnalyticalTables = throttle(
  async function (
    since: Date = new Date(
      Date.now() - parseInt(process.env.REFRESH_RATE_ANALYTICAL_VIEWS) * 2,
    ),
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
  },
);

(async function () {
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

  for await (const message of streamClient.streamData({
    filter: [
      Filter.make({
        events: EVENT_PROCESSORS.map((ep) => ({
          fromAddress: ep.filter.fromAddress,
          keys: ep.filter.keys,
          includeReceipt: true,
          includeTransaction: true,
        })),
      }),
    ],
    finality: "pending",
    startingCursor: databaseStartingCursor
      ? databaseStartingCursor
      : { orderKey: BigInt(process.env.STARTING_CURSOR_BLOCK_NUMBER ?? 0) },
  })) {
    switch (message._tag) {
      case "heartbeat": {
        logger.info(`Heartbeat`);
        break;
      }

      case "invalidate": {
        let invalidatedCursor = message.invalidate.cursor;

        logger.warn(`Invalidated cursor`, {
          cursor: invalidatedCursor,
        });

        const client = await pool.connect();
        const dao = new DAO(client);

        await dao.beginTransaction();
        await dao.deleteOldBlockNumbers(Number(invalidatedCursor.orderKey) + 1);
        await dao.writeCursor(message.invalidate.cursor);
        await dao.commitTransaction();

        client.release();
        break;
      }

      case "data": {
        const blockProcessingTimer = logger.startTimer();

        const client = await pool.connect();
        const dao = new DAO(client);

        await dao.beginTransaction();

        let isPending: boolean = false;

        let deletedCount: number = 0;

        for (const block of message.data.data) {
          const blockNumber = Number(block.header.blockNumber);
          deletedCount += await dao.deleteOldBlockNumbers(blockNumber);

          // for pending blocks we update operational materialized views before we commit
          isPending = isPending || BigInt(block.header.blockHash) === 0n ||
              // blocks in the last 5 minutes are considered pending
              blockTime.getTime() > Date.now() - 300_000;

          const blockTime = block.header.timestamp;

          await dao.insertBlock({
            hash: BigInt(block.header.blockHash),
            number: block.header.blockNumber,
            time: blockTime,
          });

          // const transactionSenders: {
          //   [transactionHash: string]: string;
          // } = {};

          // const transactionReceipts: {
          //   [transactionHash: string]: {
          //     feePaid: bigint;
          //     feePaidUnit: PriceUnit;
          //   };
          // } = {};

          for (const event of block.events) {
            const eventKey: EventKey = {
              blockNumber,
              transactionIndex: event.transactionIndex,
              eventIndex: event.eventIndex,
              fromAddress: BigInt(event.fromAddress),
              transactionHash: BigInt(event.transactionHash),
            };

            // const rawSender =
            //   transaction?.invokeV1?.senderAddress ??
            //   transaction.invokeV3?.senderAddress ??
            //   transaction?.invokeV0?.contractAddress ??
            //   transaction?.declare?.senderAddress;
            //
            // const senderHex = rawSender ? FieldElement.toHex(rawSender) : null;

            // const feePaid = FieldElement.toBigInt(
            //   receipt.actualFee ?? receipt.actualFeePaid?.amount,
            // );
            // const feePaidUnit = receipt.actualFeePaid?.unit ?? "unknown";

            // process each event sequentially through all the event processors in parallel
            // assumption is that none of the event processors operate on the same events, i.e. have the same filters
            // this assumption could be validated at runtime
            await Promise.all(
              EVENT_PROCESSORS.map(async ({ parser, handle, filter }) => {
                if (
                  BigInt(event.fromAddress) === BigInt(filter.fromAddress) &&
                  event.keys.length === filter.keys.length &&
                  event.keys.every(
                    (key, ix) => BigInt(key) === BigInt(filter.keys[ix]),
                  )
                ) {
                  const transactionMapKey = eventKey.transactionHash.toString();
                  // if (senderHex) {
                  //   transactionSenders[transactionMapKey] = senderHex;
                  // }

                  // transactionReceipts[transactionMapKey] = transactionReceipts[
                  //   transactionMapKey
                  // ] ?? {
                  //   feePaid,
                  //   feePaidUnit,
                  // };

                  const parsed = parser(event.data, 0).value;

                  await handle(dao, {
                    parsed: parsed as any,
                    key: eventKey,
                  });
                }
              }),
            );
          }

          await dao.writeCursor(message.data.cursor);

          // await dao.writeTransactionSenders(Object.entries(transactionSenders),);
          //
          // await dao.writeReceipts(Object.entries(transactionReceipts));

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
              Date.now() - Number(blockTime.getTime()),
            ),
          });
        }

        client.release();

        if (isPending) {
          refreshAnalyticalTables();
        }

        break;
      }

      default: {
        logger.error(`Unknown message type: ${message._tag}`);
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
