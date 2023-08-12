import "./config";
import {
  FieldElement,
  Filter,
  StarkNetCursor,
  v1alpha2 as starknet,
} from "@apibara/starknet";
import { Cursor, StreamClient, v1alpha2 } from "@apibara/protocol";
import { EventProcessor } from "./processor";
import { logger } from "./logger";
import { DAO } from "./dao";
import {
  FeesPaidEvent,
  FeesWithdrawnEvent,
  parseFeesPaidEvent,
  parsePoolInitializedEvent,
  parsePositionFeesCollectedEvent,
  parsePositionUpdatedEvent,
  parseProtocolFeesWithdrawnEvent,
  parseSwappedEvent,
  PoolInitializationEvent,
  PositionFeesCollectedEvent,
  PositionUpdatedEvent,
  SwappedEvent,
} from "./events/core";
import {
  parsePositionMintedEvent,
  PositionMintedEvent,
} from "./events/positions";
import { parseTransferEvent, TransferEvent } from "./events/nft";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING,
  idleTimeoutMillis: 1_000,
});

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
    handle: async (dao, { key, parsed }) => {
      logger.debug("PositionMinted", { parsed, key });
      await dao.insertPositionMinted(parsed, key.blockNumber);
    },
  },
  <EventProcessor<TransferEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.NFT_ADDRESS),
      keys: [
        // Transfer
        FieldElement.fromBigInt(
          0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9n
        ),
      ],
    },
    parser: parseTransferEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("NFT transferred", { parsed, key });
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
    async handle(dao, { parsed, key }): Promise<void> {
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
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("PositionFeesCollected", { parsed, key });
      await dao.insertPositionFeesCollectedEvent(parsed, key);
    },
  },
  <EventProcessor<SwappedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // Swapped
        FieldElement.fromBigInt(
          0x157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870n
        ),
      ],
    },
    parser: parseSwappedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("Swapped", { parsed, key });
      await dao.insertSwappedEvent(parsed, key);
    },
  },
  <EventProcessor<PoolInitializationEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // PoolInitialized
        FieldElement.fromBigInt(
          0x025ccf80ee62b2ca9b97c76ccea317c7f450fd6efb6ed6ea56da21d7bb9da5f1n
        ),
      ],
    },
    parser: parsePoolInitializedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("PoolInitialized", { parsed, key });
      await dao.insertInitializationEvent(parsed, key);
    },
  },
  <EventProcessor<FeesWithdrawnEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // ProtocolFeesWithdrawn
        FieldElement.fromBigInt(
          0x291697c8230383d5c3cc8dc39443356a7da6b0735605fb0ee0f7bfbb7b824an
        ),
      ],
    },
    parser: parseProtocolFeesWithdrawnEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("ProtocolFeesWithdrawn", { parsed, key });
      await dao.insertProtocolFeesWithdrawn(parsed, key);
    },
  },
  <EventProcessor<FeesPaidEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // ProtocolFeesPaid
        FieldElement.fromBigInt(
          0x5dacf59794364ad1555bb3c9b2346afa81e57e5c19bb6bae0d22721c96c4e5n
        ),
      ],
    },
    parser: parseFeesPaidEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("ProtocolFeesPaid", { parsed, key });
      await dao.insertProtocolFeesPaid(parsed, key);
    },
  },
] as const;

const client = new StreamClient({
  url: process.env.APIBARA_URL,
  token: process.env.APIBARA_AUTH_TOKEN,
});

export function parseLong(long: number | Long): bigint {
  return BigInt(typeof long === "number" ? long : long.toNumber());
}

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
      case "data": {
        if (!message.data.data) {
          logger.error(`Data message is empty`);
          break;
        } else {
          const client = await pool.connect();
          const dao = new DAO(client);

          for (const item of message.data.data) {
            const decoded = starknet.Block.decode(item);

            const blockNumber = parseLong(decoded.header.blockNumber);

            const events = decoded.events;

            await dao.beginTransaction();

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

                    await handle(dao, {
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
            await dao.commitTransaction();

            logger.info(`Processed block`, { blockNumber });
          }

          client.release();
        }

        break;
      }

      case "heartbeat": {
        logger.debug(`Heartbeat`);
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
        await dao.invalidateBlockNumber(BigInt(invalidatedCursor.orderKey));
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
  })
  .finally(async () => {
    await pool.end();
    process.exit(1);
  });
