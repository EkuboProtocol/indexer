/**
 * Replays a settled historical range through the stream and asserts that the
 * events it emits are exactly the events a direct `eth_getLogs` returns for the
 * same range.
 *
 * This exists because a missed event is the failure that is expensive to
 * diagnose: nothing errors, the cursor keeps advancing, and the gap surfaces
 * days later as a wrong number downstream. Run it against a chain and a range
 * to settle the question directly.
 *
 *   bun scripts/verifyLogStream.ts <rpc-url> <label> [blocks] [chunk] [addresses]
 *
 * Defaults to the Ekubo contract set. Passing a busy contract instead is a
 * harder test, since it exercises grouping and ordering at volume:
 *
 *   bun scripts/verifyLogStream.ts https://mainnet.base.org base 600 100 \
 *     0x4200000000000000000000000000000000000006
 *
 * Exits non-zero on any mismatch, so it can gate a deploy if wanted.
 */
import { createPublicClient, http, numberToHex } from "viem";
import { createLogStream, type LogStreamFilter } from "../src/evm/logStream";

const [url, name, spanRaw, chunkRaw, addrsRaw] = process.argv.slice(2);
const SPAN = Number(spanRaw ?? 2000);
const CHUNK = Number(chunkRaw ?? 1000);
const ADDRS = (addrsRaw ? addrsRaw.split(",") : [
  "0x00000000000014aA86C5d3c41765bb24e11bd701",
  "0x5555fF9Ff2757500BF4EE020DcfD0210CFfa41Be",
  "0x517E506700271AEa091b02f42756F5E174Af5230",
  "0xd47f1B1eDCfEaBb08F6eBd8FC337c27E636C75BA",
  "0xC52D2656cb8C634263E6A15469588beB9C3Bb738",
  "0xcB4e1b5Fb7b120dB0815aFA63453C969136C0Ec9",
  "0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D",
]) as readonly `0x${string}`[];

const client = createPublicClient({ transport: http(url!, { retryCount: 2 }) });
const head = Number(await client.getBlockNumber());
// Stay well behind the head so the range is settled and the comparison is fair.
const to = head - 200;
const from = to - SPAN + 1;

const key = (b: number | bigint, i: number) => `${Number(b)}:${i}`;

// Ground truth, in one direct call per 1000 blocks.
const truth = new Set<string>();
for (let lo = from; lo <= to; lo += CHUNK) {
  const hi = Math.min(to, lo + CHUNK - 1);
  const logs = (await client.request({
    method: "eth_getLogs",
    params: [
      {
        fromBlock: numberToHex(BigInt(lo)),
        toBlock: numberToHex(BigInt(hi)),
        address: ADDRS as unknown as `0x${string}`[],
      },
    ],
  } as never)) as unknown as { blockNumber: `0x${string}`; logIndex: `0x${string}` }[];
  for (const l of logs) truth.add(key(BigInt(l.blockNumber), Number(l.logIndex)));
}

const filters: LogStreamFilter[] = ADDRS.map((a, i) => ({
  id: i + 1,
  address: a as `0x${string}`,
  topics: [],
  strict: false,
}));

const seen = new Set<string>();
let blocks = 0;
const stream = createLogStream({
  rpc: { request: (client as never as { request: never }).request },
  filters,
  startingCursor: { orderKey: BigInt(from - 1) },
  options: { pollIntervalMs: 50, maxLogRangeBlocks: CHUNK, reorgWindowBlocks: 32 },
});

for await (const msg of stream) {
  if (msg._tag !== "data") continue;
  blocks++;
  for (const block of msg.data.data) {
    for (const log of block.logs) {
      seen.add(key(block.header.blockNumber, log.logIndex));
    }
  }
  if (Number(msg.data.endCursor.orderKey) >= to) break;
}

const missed = [...truth].filter((k) => !seen.has(k));
const extra = [...seen].filter((k) => !truth.has(k) && Number(k.split(":")[0]) <= to);

console.log(
  JSON.stringify({
    chain: name,
    range: `${from}..${to}`,
    blocksEmitted: blocks,
    eventsFromDirectQuery: truth.size,
    eventsFromStream: seen.size,
    missed: missed.length,
    extra: extra.length,
    verdict: missed.length === 0 && extra.length === 0 ? "EXACT MATCH" : "MISMATCH",
    ...(missed.length ? { missedSample: missed.slice(0, 5) } : {}),
    ...(extra.length ? { extraSample: extra.slice(0, 5) } : {}),
  }),
);
process.exit(missed.length === 0 && extra.length === 0 ? 0 : 1);
