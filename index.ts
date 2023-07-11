import "./lib/config";

import {
  FieldElement,
  Filter,
  StarkNetCursor,
  v1alpha2 as starknet,
} from "@apibara/starknet";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { Cursor, StreamClient, v1alpha2 } from "@apibara/protocol";
import { printError, printLog } from "./lib/log";
import { CloudflareKV } from "./lib/cf";
import { toNftAttributes } from "./lib/minted";
import {
  parseLong,
  parsePositionMintedEvent,
  parsePositionUpdatedEvent,
} from "./lib/parse";
import { ICursor } from "@apibara/protocol/dist/proto/v1alpha2";
import { BlockMeta, EventProcessor } from "./lib/processor";

const kv = new CloudflareKV({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  namespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
});

let cursor: ICursor;
const CURSOR_PATH = process.env.CURSOR_FILE;
if (existsSync(CURSOR_PATH)) {
  try {
    cursor = Cursor.fromObject(JSON.parse(readFileSync(CURSOR_PATH, "utf8")));
  } catch (error) {
    printError(`Failed to parse cursor file`, error);
    throw error;
  }
} else {
  const blockNumber = process.env.STARTING_CURSOR_BLOCK_NUMBER ?? 0;
  cursor = StarkNetCursor.createWithBlockNumber(Number(blockNumber));
  printLog(`Cursor file not found, starting with ${blockNumber}`);
}

const EVENT_PROCESSORS: EventProcessor<any>[] = [
  {
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.POSITIONS_ADDRESS),
      keys: [
        // PositionMinted
        FieldElement.fromBigInt(
          0x2a9157ea1542bfe11220258bf15d8aa02d791e7f94426446ec85b94159929fn
        ),
      ],
    },
    parser: (ev) => parsePositionMintedEvent(ev.event.data, 0).value,
    handle: async (ev, meta) => {
      const key = ev.token_id.toString();
      await kv.write(key, JSON.stringify(toNftAttributes(ev)));
      printLog(
        `Wrote token ID ${key} from block #${
          meta.blockNumber
        } @ ${meta.blockTimestamp.toISOString()}`
      );
    },
  },
  {
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // PositionUpdated
        FieldElement.fromBigInt(
          0x03a7adca3546c213ce791fabf3b04090c163e419c808c9830fb343a4a395946en
        ),
      ],
    },
    parser: (ev) => parsePositionUpdatedEvent(ev.event.data, 0).value,
    async handle(ev, meta): Promise<void> {
      printLog("PositionUpdated", ev);
    },
  },
];

const client = new StreamClient({
  url: process.env.APIBARA_URL,
  token: process.env.APIBARA_AUTH_TOKEN,
});

client.configure({
  filter: EVENT_PROCESSORS.reduce((memo, value) => {
    return memo.addEvent((ev) =>
      ev.withKeys(value.filter.keys).withFromAddress(value.filter.fromAddress)
    );
  }, Filter.create().withHeader({ weak: true })).encode(),
  batchSize: 1,
  finality: v1alpha2.DataFinality.DATA_STATUS_PENDING,
  cursor,
});

function writeCursor(value: v1alpha2.ICursor): void {
  writeFileSync(CURSOR_PATH, JSON.stringify(Cursor.toObject(value)));
}

(async function () {
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
          printError(`Data message is empty`);
          break;
        } else {
          for (const item of message.data.data) {
            const block = starknet.Block.decode(item);

            const meta: BlockMeta = {
              blockNumber: Number(parseLong(block.header.blockNumber)),
              blockTimestamp: new Date(
                Number(parseLong(block.header.timestamp.seconds) * 1000n)
              ),
            };

            const events = block.events;

            await Promise.all(
              EVENT_PROCESSORS.flatMap((processor) => {
                return events
                  .filter((ev) => {
                    return (
                      FieldElement.toBigInt(ev.event.fromAddress) ===
                        FieldElement.toBigInt(processor.filter.fromAddress) &&
                      ev.event.keys.length === processor.filter.keys.length &&
                      ev.event.keys.every(
                        (key, ix) =>
                          FieldElement.toBigInt(key) ===
                          FieldElement.toBigInt(processor.filter.keys[ix])
                      )
                    );
                  })
                  .map(processor.parser)
                  .map((ev) => processor.handle(ev, meta));
              })
            );
          }

          writeCursor(message.data.endCursor);

          printLog(
            `Cursor updated to block #${message.data.endCursor.orderKey.toString()}`
          );
        }
        break;
      case "heartbeat":
        printLog(`Heartbeat`);
        break;
      case "invalidate":
        printLog(`Invalidated`);
        writeCursor(message.invalidate.cursor);
        break;

      case "unknown":
        printLog(`Unknown message type`);
        break;
    }
  }
})()
  .then(() => printLog("Stream closed"))
  .catch((error) => printError(error));
