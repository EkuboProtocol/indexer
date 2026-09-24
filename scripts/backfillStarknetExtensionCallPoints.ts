/**
 * After deploying live ExtensionCallPointsSet ingestion:
 * NETWORK=mainnet STARKNET_RPC_URL=... bun scripts/backfillStarknetExtensionCallPoints.ts
 *
 * Reads all history through an indexed, finalized block before taking a short
 * database lock. Publishes history and routing eligibility atomically. Never
 * resets a cursor or replays pool events. Requires RPC event positions (v0.10).
 */
import postgres from "postgres";
import { loadConfig } from "../src/config";
import { createStarknetRpc } from "../src/starknet/eventStream";
import { encodeCallPoints, parseExtensionCallPointsSet } from "../src/starknet/core";
import { checkContinuationToken, recordEventIdentity, requireBlockInRange } from "../src/_shared/rpcRecords";
import { requireRepresentableIndex } from "../src/_shared/blockStream";

const SELECTOR = "0x38a9213201ed0d67771d34d45fd58a5f718fcaf84ec8f5bcca5b8a4874fd104";
const GET_CALL_POINTS = "0x33ee9970bc09345a303b118dd52d45416b3543943a246b2b543f82f73c31b56";
type Rpc = ReturnType<typeof createStarknetRpc>;
type Event = {
  block_number: number; block_hash: string; transaction_index: number;
  event_index: number; transaction_hash: string; from_address: string;
  keys: string[]; data: string[];
};
type Block = { block_hash: string; timestamp: number; block_number: number };

async function readHistory(rpc: Rpc, core: string, through: number) {
  const events: Event[] = [];
  const tokens = new Set<string>();
  const identities = new Map<string, string>();
  let continuation_token: string | undefined;
  do {
    const page = await rpc.request<{ events: Event[]; continuation_token?: string }>(
      "starknet_getEvents", [{ from_block: { block_number: 0 },
        to_block: { block_number: through }, address: core,
        keys: [[SELECTOR]], chunk_size: 1000, continuation_token }]);
    for (const event of page.events) {
      requireBlockInRange(event.block_number, 0, through);
      requireRepresentableIndex(event.transaction_index, event.block_number, "transaction_index");
      requireRepresentableIndex(event.event_index, event.block_number, "event_index");
      recordEventIdentity(identities, event.block_number, event.block_hash,
        `${event.transaction_index}:${event.event_index}`);
      if (BigInt(event.from_address) !== BigInt(core) || BigInt(event.keys[0]!) !== BigInt(SELECTOR)) {
        throw new Error("RPC returned an unexpected event");
      }
      if (event.data.length !== 9) throw new Error("Unexpected call-point event layout");
      events.push(event);
    }
    checkContinuationToken(page.continuation_token, tokens);
    continuation_token = page.continuation_token;
  } while (continuation_token);
  return events;
}

async function verifyHistory(rpc: Rpc, core: string, blockHash: string, events: Event[]) {
  const latest = new Map<bigint, Event>();
  events.sort((a, b) => a.block_number - b.block_number ||
    a.transaction_index - b.transaction_index || a.event_index - b.event_index);
  for (const event of events) latest.set(BigInt(event.data[0]!), event);
  for (const [extension, event] of latest) {
    const flags = await rpc.request<string[]>("starknet_call", [{
      contract_address: core, entry_point_selector: GET_CALL_POINTS,
      calldata: [`0x${extension.toString(16)}`],
    }, { block_hash: blockHash }]);
    if (flags.length !== 8 || flags.some((flag, i) => BigInt(flag) !== BigInt(event.data[i + 1]!))) {
      throw new Error(`Latest event disagrees with Core for extension ${extension}`);
    }
  }
}

async function main() {
  loadConfig("starknet");
  const { PG_CONNECTION_STRING, STARKNET_RPC_URL, CHAIN_ID, CORE_ADDRESS } = process.env;
  if (!PG_CONNECTION_STRING || !STARKNET_RPC_URL || !CHAIN_ID || !CORE_ADDRESS) {
    throw new Error("Require PG_CONNECTION_STRING, STARKNET_RPC_URL, CHAIN_ID, CORE_ADDRESS");
  }
  const chain = BigInt(CHAIN_ID).toString();
  const core = BigInt(CORE_ADDRESS).toString();
  const sql = postgres(PG_CONNECTION_STRING, { max: 1 });
  const rpc = createStarknetRpc(STARKNET_RPC_URL);
  try {
    if (BigInt(await rpc.request<string>("starknet_chainId", [])) !== BigInt(chain)) {
      throw new Error("RPC chain mismatch");
    }
    const [cutoff] = await sql`SELECT b.block_number, b.block_hash::text
      FROM blocks b JOIN indexer_cursor c USING (chain_id)
      WHERE b.chain_id=${chain} AND b.block_number < c.finalized_order_key
      ORDER BY b.block_number DESC LIMIT 1`;
    if (!cutoff) throw new Error("No indexed finalized cutoff");
    const through = Number(cutoff.block_number);
    const hash = `0x${BigInt(cutoff.block_hash).toString(16)}`;
    console.log(`Fetching extension history through finalized block ${through}`);
    const events = await readHistory(rpc, CORE_ADDRESS, through);
    await verifyHistory(rpc, CORE_ADDRESS, hash, events);
    const blocks = new Map<number, Block>();
    for (const event of events) {
      const block = await rpc.request<Block>("starknet_getBlockWithTxHashes",
        [{ block_number: event.block_number }]);
      if (BigInt(block.block_hash) !== BigInt(event.block_hash)) throw new Error("Event block changed");
      blocks.set(event.block_number, block);
    }
    const anchor = await rpc.request<Block>("starknet_getBlockWithTxHashes", [{ block_number: through }]);
    if (BigInt(anchor.block_hash) !== BigInt(hash)) throw new Error("Finalized anchor changed");
    await sql.begin(async tx => {
      await tx`SET LOCAL lock_timeout = '10s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      // Same lock order as migrations: park workers before touching child tables.
      await tx`LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE`;
      const [held] = await tx`SELECT block_hash::text FROM blocks
        WHERE chain_id=${chain} AND block_number=${through}`;
      if (!held || BigInt(held.block_hash) !== BigInt(hash)) throw new Error("Database anchor changed");
      for (const [number, block] of blocks) {
        await tx`INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
          VALUES (${chain}, ${number}, ${BigInt(block.block_hash).toString()},
            ${new Date(block.timestamp * 1000)}, ${events.filter(e => e.block_number === number).length})
          ON CONFLICT DO NOTHING`;
        const [stored] = await tx`SELECT block_hash::text FROM blocks
          WHERE chain_id=${chain} AND block_number=${number}`;
        if (!stored || BigInt(stored.block_hash) !== BigInt(block.block_hash)) throw new Error("Block hash conflict");
      }
      for (const event of events) {
        const parsed = parseExtensionCallPointsSet(event.data, 0).value;
        await tx`INSERT INTO starknet_extension_call_points
          (chain_id, block_number, transaction_index, event_index, transaction_hash,
           emitter, pool_extension, call_points)
          VALUES (${chain}, ${event.block_number}, ${event.transaction_index}, ${event.event_index},
            ${BigInt(event.transaction_hash).toString()}, ${core}, ${parsed.extension.toString()},
            ${encodeCallPoints(parsed.call_points)}) ON CONFLICT DO NOTHING`;
      }
      await tx`INSERT INTO starknet_extension_call_points_backfill
        (chain_id, core_address, through_block) VALUES (${chain}, ${core}, ${through})
        ON CONFLICT (chain_id, core_address) DO UPDATE
        SET through_block=GREATEST(starknet_extension_call_points_backfill.through_block, EXCLUDED.through_block)`;
      await tx`SELECT refresh_starknet_extension_routing(${chain}, ${core})`;
    });
    console.log(`Backfilled ${events.length} events; latest flags verified against Core. Routing ready.`);
  } finally { await sql.end(); }
}

if (import.meta.main) await main();
