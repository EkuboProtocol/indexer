/**
 * Replays a settled historical range through the Starknet adapter and asserts
 * that the events it produces carry exactly the positions the database already
 * holds for them.
 *
 * This is the check that matters for the move off the apibara DNA stream.
 * `transaction_index` and `event_index` are packed into `event_id`, which is a
 * primary key other tables order on, so getting them wrong would not error --
 * it would write rows that collide with or silently duplicate years of existing
 * history. They come from `starknet_getEvents` under JSON-RPC v0.10; under v0.9
 * they are absent entirely, which is why the URL pins a version.
 *
 * The DNA stream wrote the rows already in the database. Reproducing them from
 * the RPC, for a range indexed long before this code existed, is the only way
 * to be sure the two agree.
 *
 *   bun scripts/verifyStarknetStream.ts <rpc-url> [blocks]
 *
 * Needs PG_CONNECTION_STRING and the Starknet contract addresses in the
 * environment. Exits non-zero on any mismatch, so it can gate a deploy.
 */
import postgres from "postgres";
import { loadHexAddresses } from "../src/_shared/loadHexAddresses";
import { createEventProcessors } from "../src/starknet/eventProcessors";
import {
  createStarknetAdapter,
  createStarknetRpc,
  type StarknetStreamFilter,
} from "../src/starknet/eventStream";

const [url, spanRaw] = process.argv.slice(2);
if (!url) throw new Error("usage: verifyStarknetStream.ts <rpc-url> [blocks]");
const SPAN = Number(spanRaw ?? 2000);
const CHUNK = 500;

const addresses = loadHexAddresses({
  nftAddress: "NFT_ADDRESS",
  coreAddress: "CORE_ADDRESS",
  positionsAddress: "POSITIONS_ADDRESS",
  tokenRegistryAddress: "TOKEN_REGISTRY_ADDRESS",
  tokenRegistryV2Address: "TOKEN_REGISTRY_V2_ADDRESS",
  tokenRegistryV3Address: "TOKEN_REGISTRY_V3_ADDRESS",
  twammAddress: "TWAMM_ADDRESS",
  stakerAddress: "STAKER_ADDRESS",
  governorAddress: "GOVERNOR_ADDRESS",
  oracleAddress: "ORACLE_ADDRESS",
  limitOrdersAddress: "LIMIT_ORDERS_ADDRESS",
  splineLiquidityProviderAddress: "SPLINE_LIQUIDITY_PROVIDER_ADDRESS",
});
if (!addresses) throw new Error("Missing or invalid Starknet addresses");

const processors = createEventProcessors(addresses);
const filters: StarknetStreamFilter[] = processors.map((processor, ix) => ({
  id: ix + 1,
  fromAddress: processor.filter.fromAddress,
  keys: processor.filter.keys,
}));

const rpc = createStarknetRpc(url);
const adapter = createStarknetAdapter({ rpc, filters });

const head = await adapter.fetchHead();
if (!head) throw new Error("could not read the head");
// Stay well behind the head so the range is settled and the comparison is fair.
const to = head.number - 500;
const from = to - SPAN + 1;
console.log(`verifying blocks ${from}..${to} against the database`);

// The Swapped event on Core, which is what the `swaps` table holds. Comparing
// against one table keeps this an exact set equality rather than a sampling.
const SWAPPED = BigInt(
  "0x157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870",
);
const CORE = BigInt(addresses.coreAddress);

const fromStream = new Set<string>();
for (let start = from; start <= to; start += CHUNK) {
  const end = Math.min(to, start + CHUNK - 1);
  const blocks = await adapter.readRange(start, end);
  await adapter.completeFresh(blocks, head);
  for (const block of blocks) {
    for (const event of block.logs) {
      if (BigInt(event.address) !== CORE) continue;
      if (event.keys[0] === undefined || BigInt(event.keys[0]) !== SWAPPED) {
        continue;
      }
      fromStream.add(
        `${block.header.blockNumber}:${event.transactionIndex}:${event.eventIndex}`,
      );
    }
  }
  process.stdout.write(`  read ${start}..${end}\r`);
}
console.log(`\nstream produced ${fromStream.size} Swapped events`);

const sql = postgres(process.env.PG_CONNECTION_STRING!, {
  types: { bigint: postgres.BigInt },
});
const chainId = BigInt(process.env.CHAIN_ID!);
const rows = await sql<
  { block_number: string; transaction_index: number; event_index: number }[]
>`SELECT block_number, transaction_index, event_index
    FROM swaps
   WHERE chain_id = ${chainId}
     AND block_number BETWEEN ${from} AND ${to}`;
const fromDb = new Set(
  rows.map(
    (r) => `${r.block_number}:${r.transaction_index}:${r.event_index}`,
  ),
);
console.log(`database holds  ${fromDb.size} Swapped events`);
await sql.end();

const missing = [...fromDb].filter((k) => !fromStream.has(k));
const extra = [...fromStream].filter((k) => !fromDb.has(k));

if (missing.length === 0 && extra.length === 0) {
  console.log(`OK: ${fromDb.size} events agree exactly on block:tx:event`);
  process.exit(0);
}

console.error(`MISMATCH`);
if (missing.length) {
  console.error(`  in the database but not produced (${missing.length}):`);
  for (const k of missing.slice(0, 20)) console.error(`    ${k}`);
}
if (extra.length) {
  console.error(`  produced but not in the database (${extra.length}):`);
  for (const k of extra.slice(0, 20)) console.error(`    ${k}`);
}
process.exit(1);
