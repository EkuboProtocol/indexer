import {
  FieldElement,
  Filter,
  StarkNetCursor,
  v1alpha2 as starknet,
} from "@apibara/starknet";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { StreamClient, v1alpha2, Cursor } from "@apibara/protocol";
import { ICursor } from "@apibara/protocol/dist/proto/v1alpha2";

// Grab Apibara DNA token from environment, if any.
const APIBARA_AUTH_TOKEN = process.env.APIBARA_AUTH_TOKEN;
const APIBARA_URL = process.env.APIBARA_URL;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const CURSOR_FILE = process.env.CURSOR_FILE || "./cursor.json";

console.log(`${new Date().toISOString()}:
Starting with config: 
APIBARA_URL: "${APIBARA_URL}"
CLOUDFLARE_ACCOUNT_ID: "${CLOUDFLARE_ACCOUNT_ID}"
CLOUDFLARE_KV_NAMESPACE_ID: "${CLOUDFLARE_KV_NAMESPACE_ID}"`);

async function writeToKV({
  key,
  value,
}: {
  key: string;
  value: string;
}): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${key}`;

  const response = await fetch(url, {
    method: "PUT",
    body: value,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to write to KV store: ${message}`);
  }
}

const client = new StreamClient({
  url: APIBARA_URL,
  token: APIBARA_AUTH_TOKEN,
});

const POSITIONS_ADDRESS = FieldElement.fromBigInt(
  "0x061064fad8ca4cd066450f4e572246988a04143222d444b481f8d6e8039bb4d2"
);

const POSITION_MINTED_KEY = [
  FieldElement.fromBigInt(
    "0x2a9157ea1542bfe11220258bf15d8aa02d791e7f94426446ec85b94159929f"
  ),
];

const filter = Filter.create()
  .withHeader({ weak: false })
  .addEvent((ev) =>
    ev.withFromAddress(POSITIONS_ADDRESS).withKeys(POSITION_MINTED_KEY)
  )
  .encode();

let cursor = StarkNetCursor.createWithBlockNumber(0);
const CURSOR_PATH = resolve(__dirname, CURSOR_FILE);
if (existsSync(CURSOR_PATH)) {
  try {
    cursor = Cursor.fromObject(JSON.parse(readFileSync(CURSOR_PATH, "utf8")));
  } catch (error) {
    console.error(`${new Date().toISOString()}: Failed to parse cursor`);
  }
} else {
  console.log(`${new Date().toISOString()}: Cursor file not found`);
}

client.configure({
  filter,
  batchSize: 1,
  finality: v1alpha2.DataFinality.DATA_STATUS_PENDING,
  cursor,
});

interface PoolKey {
  token0: string;
  token1: string;
  fee: bigint;
  tick_spacing: number;
  extension: bigint;
}

interface Bounds {
  tick_lower: number;
  tick_upper: number;
}

interface PositionMintedEvent {
  token_id: bigint;
  pool_key: PoolKey;
  bounds: Bounds;
}

function toNftAttributes(e: PositionMintedEvent): {
  trait_type: string;
  value: string;
}[] {
  return [
    { trait_type: "token0", value: e.pool_key.token0 },
    { trait_type: "token1", value: e.pool_key.token1 },
    { trait_type: "fee", value: e.pool_key.fee.toString() },
    { trait_type: "tick_spacing", value: e.pool_key.tick_spacing.toString() },
    { trait_type: "extension", value: e.pool_key.extension.toString() },
    { trait_type: "tick_lower", value: e.bounds.tick_lower.toString() },
    { trait_type: "tick_upper", value: e.bounds.tick_upper.toString() },
  ];
}

function updateCursor(value: ICursor): void {
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
    console.log(
      `${new Date().toISOString()}: Received message of type ${messageType}`
    );
    switch (messageType) {
      case "data":
        if (!message.data.data) break;

        for (const item of message.data.data) {
          const block = starknet.Block.decode(item);

          const blockTimestamp = new Date(
            Number(
              BigInt(
                typeof block.header.timestamp.seconds === "number"
                  ? block.header.timestamp.seconds
                  : block.header.timestamp.seconds.toNumber()
              ) * 1000n
            )
          );

          const events = block.events;

          const positionMintedEvents = events
            .filter((ev) =>
              ev.event.keys.every(
                (key, ix) =>
                  FieldElement.toHex(key) ===
                  FieldElement.toHex(POSITION_MINTED_KEY[ix])
              )
            )
            .map<PositionMintedEvent>((ev) => {
              return {
                token_id: BigInt(FieldElement.toHex(ev.event.data[0])),
                pool_key: {
                  token0: FieldElement.toHex(ev.event.data[2]),
                  token1: FieldElement.toHex(ev.event.data[3]),
                  fee: BigInt(FieldElement.toHex(ev.event.data[4])),
                  tick_spacing: Number(FieldElement.toHex(ev.event.data[5])),
                  extension: BigInt(FieldElement.toHex(ev.event.data[6])),
                },
                bounds: {
                  tick_lower:
                    Number(FieldElement.toHex(ev.event.data[7])) *
                    (Number(FieldElement.toHex(ev.event.data[8])) === 0
                      ? 1
                      : -1),
                  tick_upper:
                    Number(FieldElement.toHex(ev.event.data[9])) *
                    (Number(FieldElement.toHex(ev.event.data[10])) === 0
                      ? 1
                      : -1),
                },
              };
            });

          await Promise.all(
            positionMintedEvents.map(async (event) => {
              const key = event.token_id.toString();
              const value = JSON.stringify(toNftAttributes(event));
              await writeToKV({ key, value });
              console.log(
                `${new Date().toISOString()}: Wrote ${key} from block @ ${blockTimestamp.toISOString()}`
              );
            })
          );
        }

        updateCursor(message.data.cursor);
        break;
      case "heartbeat":
        console.log(`${new Date().toISOString()}: Heartbeat`);
        break;
      case "invalidate":
        console.log(`${new Date().toISOString()}: Invalidated`);
        updateCursor(message.invalidate.cursor);
        break;
    }
  }
})()
  .then(() => console.log("done"))
  .catch((error) => console.error(error));
