/**
 * Fills transaction_senders (00142) for swaps and position updates indexed
 * before the workers started recording senders. Live indexing records them for
 * every new block, so this only ever walks history.
 *
 *   NETWORK=mainnet bun scripts/backfillTransactionSenders.ts evm [--apply]
 *   NETWORK=mainnet bun scripts/backfillTransactionSenders.ts starknet [--apply]
 *
 * Options: --from <block> (default: the chain's first stored block),
 * --to <block> (default: the stored finalized block), --window <blocks>
 * (default 2000), --concurrency <blocks in flight> (default 8).
 *
 * Without --apply it reads the RPC and reports, but writes nothing. Walks
 * newest first, so recent trades gain senders first. Resumable: a window only
 * selects transactions that have no row yet, so re-running after an
 * interruption continues where it stopped, and a row the live worker wrote
 * first is left alone. EVM reads each transaction by block hash and index
 * (20 Alchemy CU each); Starknet reads each block once (20 CU per block).
 */
import postgres from "postgres";
import { createPublicClient, http } from "viem";
import { loadConfig } from "../src/config";
import { withNullBlockRetry } from "../src/_shared/nullBlockRetry";
import { requireEvmRpcUrls } from "../src/_shared/streamEndpoints";
import { fetchEvmTransactionSenders } from "../src/evm/transactionSenders";
import { createStarknetRpc } from "../src/starknet/eventStream";
import { fetchStarknetTransactionSenders } from "../src/starknet/transactionSenders";
import {
  descendingWindows,
  fetchBlockSenders,
  groupByBlock,
  toColumns,
  type FetchSenders,
  type MissingSenderRow,
} from "./transactionSenderBackfill";

type NetworkType = "evm" | "starknet";

const args = process.argv.slice(2);
const networkType = args[0] as NetworkType;
if (networkType !== "evm" && networkType !== "starknet") {
  throw new Error(
    "usage: backfillTransactionSenders.ts <evm|starknet> [--from N] [--to N] [--window N] [--concurrency N] [--apply]",
  );
}
loadConfig(networkType);

function option(name: string): number | null {
  const at = args.indexOf(name);
  if (at === -1) return null;
  const value = Number(args[at + 1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} needs a non-negative integer`);
  }
  return value;
}

const apply = args.includes("--apply");
const windowSize = option("--window") ?? 2_000;
const concurrency = option("--concurrency") ?? 8;
const chainId = BigInt(process.env.CHAIN_ID!);
const sql = postgres(process.env.PG_CONNECTION_STRING!, { max: 2 });

function createFetchSenders(): FetchSenders {
  if (networkType === "starknet") {
    const rpc = createStarknetRpc(process.env.STARKNET_RPC_URL!);
    return (blockHash, transactions) =>
      fetchStarknetTransactionSenders(rpc, blockHash, transactions);
  }
  const [url] = requireEvmRpcUrls(process.env.EVM_RPC_URL);
  const rpc = createPublicClient({
    transport: withNullBlockRetry(http(url, { retryCount: 4 }), { url }),
  });
  return (blockHash, transactions) =>
    fetchEvmTransactionSenders(rpc, blockHash, transactions);
}

async function storedRange(): Promise<{ from: number; to: number } | null> {
  const [row] = await sql<{ first: string | null; finalized: string | null }[]>`
    SELECT (SELECT min(block_number) FROM blocks WHERE chain_id = ${chainId.toString()}) AS first,
           (SELECT finalized_order_key FROM indexer_cursor WHERE chain_id = ${chainId.toString()}) AS finalized
  `;
  const from = option("--from") ?? (row?.first ? Number(row.first) : null);
  const to = option("--to") ?? (row?.finalized ? Number(row.finalized) : null);
  return from === null || to === null ? null : { from, to };
}

// Swaps and position updates in the window whose transaction has no sender,
// through the (chain_id, event_id) primary keys.
function missingSenders(from: number, to: number) {
  const chain = chainId.toString();
  return sql<MissingSenderRow[]>`
    WITH bounds AS (SELECT compute_event_id(${from}, 0, 0)     AS lo,
                           compute_event_id(${to} + 1, 0, 0) AS hi),
         events AS (SELECT block_number, transaction_index, transaction_hash
                    FROM swaps, bounds
                    WHERE chain_id = ${chain} AND event_id >= lo AND event_id < hi
                    UNION
                    SELECT block_number, transaction_index, transaction_hash
                    FROM position_updates, bounds
                    WHERE chain_id = ${chain} AND event_id >= lo AND event_id < hi)
    SELECT e.block_number::text, b.block_hash::text, e.transaction_index,
           e.transaction_hash::text
    FROM events e
             JOIN blocks b ON b.chain_id = ${chain} AND b.block_number = e.block_number
    WHERE NOT EXISTS (SELECT 1
                      FROM transaction_senders ts
                      WHERE ts.chain_id = ${chain}
                        AND ts.block_number = e.block_number
                        AND ts.transaction_index = e.transaction_index)
  `;
}

async function insert(columns: ReturnType<typeof toColumns>): Promise<number> {
  const result = await sql`
    INSERT INTO transaction_senders (chain_id, block_number, transaction_index, sender)
    SELECT ${chainId.toString()}::int8, t.block_number::int8, t.transaction_index, t.sender::numeric
    FROM unnest(${columns.blockNumbers}::text[], ${columns.transactionIndexes}::int4[],
                ${columns.senders}::text[]) AS t(block_number, transaction_index, sender)
    ON CONFLICT (chain_id, block_number, transaction_index) DO NOTHING
  `;
  return result.count;
}

async function main() {
  const range = await storedRange();
  if (!range) throw new Error(`No stored blocks for chain ${chainId}`);
  const fetchSenders = createFetchSenders();
  const totals = { blocks: 0, transactions: 0, inserted: 0 };
  const started = Date.now();

  for (const window of descendingWindows(range.from, range.to, windowSize)) {
    const blocks = groupByBlock(await missingSenders(window.from, window.to));
    const senders = await fetchBlockSenders(blocks, fetchSenders, concurrency);
    const columns = toColumns(senders);
    const inserted = apply ? await insert(columns) : 0;
    totals.blocks += blocks.length;
    totals.transactions += columns.senders.length;
    totals.inserted += inserted;
    console.log(
      JSON.stringify({
        ...window,
        blocks: blocks.length,
        senders: columns.senders.length,
        inserted,
        apply,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
      }),
    );
  }
  console.log(
    JSON.stringify({
      done: true,
      chainId: String(chainId),
      ...range,
      ...totals,
    }),
  );
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
