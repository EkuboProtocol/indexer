import {
  FieldElement,
  Filter,
  StarkNetCursor,
  v1alpha2 as starknet,
} from "@apibara/starknet";
import { StreamClient } from "@apibara/protocol";

// Grab Apibara DNA token from environment, if any.
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const URL = process.env.APIBARA_URL ?? "goerli.starknet.a5a.ch";

const client = new StreamClient({
  url: URL,
  token: AUTH_TOKEN,
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
  .withHeader({ weak: true })
  .addEvent((ev) =>
    ev.withFromAddress(POSITIONS_ADDRESS).withKeys(POSITION_MINTED_KEY)
  )
  .encode();

const cursor = StarkNetCursor.createWithBlockNumber(829470);

client.configure({
  filter,
  batchSize: 1,
  finality: 1,
  cursor,
});

(async function () {
  for await (const message of client) {
    if (message.data?.data) {
      for (const item of message.data.data) {
        const block = starknet.Block.decode(item);

        const events = block.events;

        const relevant = events.filter((ev) =>
          ev.event.keys.every(
            (key, ix) =>
              FieldElement.toHex(key) ===
              FieldElement.toHex(POSITION_MINTED_KEY[ix])
          )
        );

        console.log("event", relevant);
      }
    }
  }
})()
  .then(() => console.log("done"))
  .catch((error) => console.error);
