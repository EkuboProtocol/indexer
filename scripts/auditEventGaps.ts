import postgres from "postgres";
import { createPublicClient, http } from "viem";
import type { ChainAdapter } from "../src/_shared/blockStream";
import { loadConfig } from "../src/config";
import { createEvmProcessors } from "../src/evm";
import { DAO } from "../src/_shared/dao";
import { createEvmAdapter } from "../src/evm/logStream";
import { logStreamFilters } from "../src/evm/logProcessorsShared";
import { createStarknetProcessors } from "../src/starknet";
import {
  createStarknetAdapter,
  createStarknetRpc,
} from "../src/starknet/eventStream";
import { isNetworkTypeValid } from "../src/types";

const networkType = process.env.AUDIT_NETWORK_TYPE ?? "evm";
if (!isNetworkTypeValid(networkType))
  throw new Error(`Bad AUDIT_NETWORK_TYPE ${networkType}`);
loadConfig(networkType);

const chainId = BigInt(process.env.CHAIN_ID!);
const rpcUrl =
  process.env.AUDIT_RPC_URL ??
  (networkType === "evm"
    ? process.env.EVM_RPC_URL
    : process.env.STARKNET_RPC_URL);
if (!rpcUrl) throw new Error("Set AUDIT_RPC_URL");

async function createAuditAdapter(
  url: string,
): Promise<ChainAdapter<{ address: string; filterIds: number[] }>> {
  let servedChainId: bigint;
  let adapter: ChainAdapter<{ address: string; filterIds: number[] }>;
  if (networkType === "evm") {
    const filters = logStreamFilters(createEvmProcessors());
    const rpc = createPublicClient({ transport: http(url, { retryCount: 4 }) });
    servedChainId = BigInt(await rpc.getChainId());
    const dao = DAO.create(process.env.PG_CONNECTION_STRING!, chainId);
    adapter = createEvmAdapter(
      rpc,
      filters,
      Number.MAX_SAFE_INTEGER,
      (source) => dao.loadDiscoveredAddresses(source),
    );
  } else {
    const filters = createStarknetProcessors().map((processor, ix) => ({
      id: ix + 1,
      fromAddress: processor.filter.fromAddress,
      keys: processor.filter.keys,
    }));
    const rpc = createStarknetRpc(url);
    servedChainId = BigInt(await rpc.request<string>("starknet_chainId", []));
    adapter = createStarknetAdapter({ rpc, filters });
  }
  if (servedChainId !== chainId) {
    throw new Error(
      `AUDIT_RPC_URL serves chain ${servedChainId}, expected ${chainId}`,
    );
  }
  return adapter;
}
const adapter = await createAuditAdapter(rpcUrl);

const sql = postgres(process.env.PG_CONNECTION_STRING!, {
  max: 1,
  connection: { default_transaction_read_only: true },
});

const [cursor] = await sql<
  { finalized_order_key: string | null; order_key: string }[]
>`
  SELECT finalized_order_key, order_key FROM indexer_cursor WHERE chain_id = ${String(chainId)}`;
const [fromArg, toArg] = process.argv.slice(2);
const to = Number(toArg ?? cursor?.finalized_order_key ?? cursor?.order_key);
const start = Number(process.env.STARTING_CURSOR_BLOCK_NUMBER!) + 1;
const from =
  fromArg !== undefined
    ? Number(fromArg)
    : process.env.AUDIT_LAST_SECONDS
      ? Math.max(
          start,
          to - (await blocksIn(Number(process.env.AUDIT_LAST_SECONDS), to)),
        )
      : start;

async function blocksIn(seconds: number, to: number): Promise<number> {
  const probe = Math.min(1_000, to - 1);
  const [end, begin] = await Promise.all([
    adapter.fetchBlock(to),
    adapter.fetchBlock(to - probe),
  ]);
  if (!end || !begin)
    throw new Error(
      `Could not read blocks ${to - probe} and ${to} to size the window`,
    );
  const elapsed = (end.timestamp.getTime() - begin.timestamp.getTime()) / 1_000;
  const rate = elapsed > 0 ? probe / elapsed : 1;
  return Math.ceil(rate * seconds);
}
if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) {
  throw new Error(`Bad range ${from}..${to}`);
}

type Row = { hash: string; events: number };
async function storedBlocks(lo: number, hi: number): Promise<Map<number, Row>> {
  const rows = await sql<
    { block_number: string; block_hash: string; num_events: number }[]
  >`
    SELECT block_number, block_hash, num_events FROM blocks
    WHERE chain_id = ${String(chainId)} AND block_number BETWEEN ${lo} AND ${hi}`;
  return new Map(
    rows.map((r) => [
      Number(r.block_number),
      {
        hash: `0x${BigInt(r.block_hash).toString(16).padStart(64, "0")}`,
        events: r.num_events,
      },
    ]),
  );
}

const totals = {
  blocksOnChain: 0,
  eventsOnChain: 0,
  rows: 0,
  missing: 0,
  hash: 0,
  count: 0,
  extra: 0,
  missingEvents: 0,
};
const report = (line: Record<string, unknown>) =>
  console.log(JSON.stringify(line));

let span = Number(process.env.AUDIT_RANGE ?? 2000);
const maxSpan = Number(
  process.env.AUDIT_MAX_RANGE ?? (networkType === "starknet" ? 5_000 : 100_000),
);
if (!Number.isSafeInteger(maxSpan) || maxSpan <= 0)
  throw new Error(`Bad AUDIT_MAX_RANGE ${process.env.AUDIT_MAX_RANGE}`);
let failures = 0;
let lastProgress = Date.now();
const delayMs = Number(process.env.AUDIT_DELAY_MS ?? 0);
const reportCounts = process.env.AUDIT_REPORT_COUNTS === "1";
let lo = from;
while (lo <= to) {
  const hi = Math.min(to, lo + span - 1);
  let blocks;
  try {
    blocks = await adapter.readRange(lo, hi);
    failures = 0;
  } catch (error) {
    if (++failures > 10) throw error;
    span = Math.max(1, Math.floor(span / 2));
    await Bun.sleep(Math.min(60_000, 500 * 2 ** failures));
    continue;
  }
  if (delayMs > 0) await Bun.sleep(delayMs);
  const stored = await storedBlocks(lo, hi);
  totals.rows += stored.size;

  for (const block of blocks) {
    const n = Number(block.header.blockNumber);
    const events = block.logs.reduce((t, log) => t + log.filterIds.length, 0);
    const byAddress: Record<string, number> = {};
    for (const log of block.logs)
      byAddress[log.address.toLowerCase()] =
        (byAddress[log.address.toLowerCase()] ?? 0) + 1;
    totals.blocksOnChain++;
    totals.eventsOnChain += events;

    const row = stored.get(n);
    stored.delete(n);
    const chain = { hash: block.header.blockHash, events, byAddress };
    if (!row) {
      totals.missing++;
      totals.missingEvents += events;
      report({ kind: "missing", block: n, chain });
    } else if (BigInt(row.hash) !== BigInt(block.header.blockHash)) {
      totals.hash++;
      report({ kind: "hash", block: n, chain, db: row });
    } else if (row.events !== events) {
      totals.count++;
      if (reportCounts) report({ kind: "count", block: n, chain, db: row });
    }
  }
  for (const [n, row] of stored) {
    totals.extra++;
    report({ kind: "extra", block: n, db: row });
  }

  lo = hi + 1;
  if (Date.now() - lastProgress > 60_000) {
    lastProgress = Date.now();
    console.error(JSON.stringify({ progress: hi, to, ...totals }));
  }
  span = Math.min(span * 2, maxSpan);
}

report({ kind: "summary", chainId: String(chainId), from, to, ...totals });
await sql.end();
process.exit(totals.missing + totals.hash > 0 ? 1 : 0);
