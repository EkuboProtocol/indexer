import "./config";
import {
  FieldElement,
  Filter,
  StarkNetCursor,
  v1alpha2 as starknet,
} from "@apibara/starknet";
import { Cursor, StreamClient, v1alpha2 } from "@apibara/protocol";
import {
  parsePoolInitializedEvent,
  parseLong,
  parsePositionMintedEvent,
  parsePositionUpdatedEvent,
  parseSwappedEvent,
  parseTransferEvent,
  PoolInitializationEvent,
  PositionMintedEvent,
  PositionUpdatedEvent,
  SwappedEvent,
  TransferEvent,
  PositionFeesCollectedEvent,
  parsePositionFeesCollectedEvent,
  FeesWithdrawnEvent,
  parseFeesWithdrawnEvent,
  FeesPaidEvent,
  parseFeesPaidEvent,
} from "./parse";
import { EventProcessor } from "./processor";
import { logger } from "./logger";
import { DAO } from "./dao";
import { Client } from "pg";

const dao = new DAO(
  new Client({
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    ssl: process.env.PGCERT
      ? {
          ca: process.env.PGCERT,
        }
      : false,
  })
);

const EVENT_PROCESSORS = [
  <EventProcessor<PositionMintedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.POSITIONS_ADDRESS),
      keys: [
        // PositionMinted
        FieldElement.fromBigInt(
          0x2a9157ea1542bfe11220258bf15d8aa02d791e7f94426446ec85b94159929fn
        ),
      ],
    },
    parser: parsePositionMintedEvent,
    handle: async ({ key, parsed }) => {
      logger.debug("PositionMinted", { parsed, key });
      await dao.insertPositionMinted(parsed, key.blockNumber);
    },
  },
  <EventProcessor<TransferEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.POSITIONS_ADDRESS),
      keys: [
        // Transfer to address 0, i.e. a burn
        FieldElement.fromBigInt(
          0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9n
        ),
      ],
    },
    parser: parseTransferEvent,
    async handle({ parsed, key }): Promise<void> {
      logger.debug("Position transferred", { parsed, key });
      await dao.insertPositionTransferEvent(parsed, key);
    },
  },
  <EventProcessor<PositionUpdatedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // PositionUpdated
        FieldElement.fromBigInt(
          0x03a7adca3546c213ce791fabf3b04090c163e419c808c9830fb343a4a395946en
        ),
      ],
    },
    parser: parsePositionUpdatedEvent,
    async handle({ parsed, key }): Promise<void> {
      logger.debug("PositionUpdated", { parsed, key });
      await dao.insertPositionUpdatedEvent(parsed, key);
    },
  },
  <EventProcessor<PositionFeesCollectedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // PositionFeesCollected
        FieldElement.fromBigInt(
          0x96982abd597114bdaa4a60612f87fabfcc7206aa12d61c50e7ba1e6c291100n
        ),
      ],
    },
    parser: parsePositionFeesCollectedEvent,
    async handle({ parsed, key }): Promise<void> {
      logger.debug("PositionFeesCollected", { parsed, key });
      await dao.insertPositionFeesCollectedEvent(parsed, key);
    },
  },
  <EventProcessor<SwappedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // swap events
        FieldElement.fromBigInt(
          0x157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870n
        ),
      ],
    },
    parser: parseSwappedEvent,
    async handle({ parsed, key }): Promise<void> {
      logger.debug("Swapped", { parsed, key });
      await dao.insertSwappedEvent(parsed, key);
    },
  },
  <EventProcessor<PoolInitializationEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // pool initialized events
        FieldElement.fromBigInt(
          0x025ccf80ee62b2ca9b97c76ccea317c7f450fd6efb6ed6ea56da21d7bb9da5f1n
        ),
      ],
    },
    parser: parsePoolInitializedEvent,
    async handle({ parsed, key }): Promise<void> {
      logger.debug("PoolInitialized", { parsed, key });
      await dao.insertInitializationEvent(parsed, key);
    },
  },
  <EventProcessor<FeesWithdrawnEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // pool initialized events
        FieldElement.fromBigInt(
          0x02c40516c55e451c62653e3176466cee959ae1775ff03c755649134c6725e81cn
        ),
      ],
    },
    parser: parseFeesWithdrawnEvent,
    async handle({ parsed, key }): Promise<void> {
      logger.debug("FeesWithdrawn", { parsed, key });
      await dao.insertFeesWithdrawn(parsed, key);
    },
  },
  <EventProcessor<FeesPaidEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // pool initialized events
        FieldElement.fromBigInt(
          0x9ea5f34ab266886deeb312652333d0e77e338de3ae1ed3d37d147a1a21fe7fn
        ),
      ],
    },
    parser: parseFeesPaidEvent,
    async handle({ parsed, key }): Promise<void> {
      logger.debug("FeesPaid", { parsed, key });
      await dao.insertFeesPaid(parsed, key);
    },
  },
] as const;

const client = new StreamClient({
  url: process.env.APIBARA_URL,
  token: process.env.APIBARA_AUTH_TOKEN,
});

(async function () {
  // first set up the schema
  const databaseStartingCursor = await dao.connectAndInit();

  logger.info(`Initialized`, {
    startingCursor: databaseStartingCursor,
  });

  client.configure({
    filter: EVENT_PROCESSORS.reduce((memo, value) => {
      return memo.addEvent((ev) =>
        ev.withKeys(value.filter.keys).withFromAddress(value.filter.fromAddress)
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

  for await (const message of client) {
    let messageType = !!message.heartbeat
      ? "heartbeat"
      : !!message.invalidate
      ? "invalidate"
      : !!message.data
      ? "data"
      : "unknown";

    switch (messageType) {
      case "data":
        if (!message.data.data) {
          logger.error(`Data message is empty`);
          break;
        } else {
          for (const item of message.data.data) {
            const decoded = starknet.Block.decode(item);

            const blockNumber = parseLong(decoded.header.blockNumber);

            const events = decoded.events;

            await dao.start();

            await dao.invalidateBlockNumber(blockNumber);

            await dao.insertBlock({
              hash: FieldElement.toBigInt(decoded.header.blockHash),
              timestamp: parseLong(decoded.header.timestamp.seconds),
              number: parseLong(decoded.header.blockNumber),
            });

            for (const { event, transaction } of events) {
              const txHash = FieldElement.toBigInt(transaction.meta.hash);

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

                    await handle({
                      parsed: parsed as any,
                      key: {
                        blockNumber,
                        txHash,
                        logIndex: parseLong(event.index),
                      },
                    });
                  }
                })
              );
            }

            await dao.writeCursor(Cursor.toObject(message.data.cursor));
            await dao.commit();

            logger.info(`Processed block`, { blockNumber });
          }
        }
        break;

      case "heartbeat":
        logger.debug(`Heartbeat`);
        break;

      case "invalidate":
        let invalidatedCursor = Cursor.toObject(message.invalidate.cursor);

        logger.warn(`Invalidated cursor`, {
          cursor: invalidatedCursor,
        });

        await dao.start();
        await dao.invalidateBlockNumber(BigInt(invalidatedCursor.orderKey));
        await dao.writeCursor(Cursor.toObject(message.invalidate.cursor));
        await dao.commit();
        break;

      case "unknown":
        logger.error(`Unknown message type`);
        break;
    }
  }
})()
  .then(() => {
    logger.info("Stream closed gracefully");
  })
  .catch((error) => {
    logger.error(error);
  })
  .finally(async () => {
    await dao.close();
    process.exit(1);
  });
