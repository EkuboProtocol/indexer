/**
 * Frozen extract of MEVCapture pool series straight from chain logs, for
 * windows the database cannot serve (no public MEVCapture coverage exists).
 *
 *   RPC_URLS=https://a,https://b OUT_DIR=./out \
 *   POOLS_JSON=./mev_v3_1.json bun scripts/extractMevCaptureSeries.ts
 *
 * POOLS_JSON is the `pools` array from the API's
 * `/poolKeys/1/<core>?extension=<MEVCapture>`; every key is re-hashed and
 * checked against the extension's on-chain state, and every pool that swaps
 * in the scanned range is checked against the extension so a pool the API
 * missed fails the run instead of being silently dropped.
 *
 * Every getLogs chunk is fetched from each RPC in RPC_URLS and must match
 * byte-for-byte. Output is CSV plus manifest.json and SHA256SUMS.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeEventLog, type Hex } from "viem";
import { CORE_ABI } from "../src/evm/abis_v3";
import { parseSwapEventV3, floatSqrtRatioToFixed, toSigned } from "../src/evm/swapEvent";
import { parseV2PoolKeyConfig, toPoolId } from "../src/evm/poolKey";
import {
  liquidityAt,
  MevCapturePoolTracker,
  timeWeightedLiquidity,
  type BlockRow,
  type CarryInDonation,
  type MevCapturePoolEvent,
  type SwapRow,
} from "../src/evm/mevCaptureSeries";

const CORE = (process.env.CORE_ADDRESS ?? "0x00000000000014aA86C5d3c41765bb24e11bd701") as Hex;
const MEV_CAPTURE = (process.env.MEV_CAPTURE_ADDRESS ??
  "0x5555fF9Ff2757500BF4EE020DcfD0210CFfa41Be") as Hex;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "1");
const RPC_URLS = (process.env.RPC_URLS ?? "").split(",").filter(Boolean);
const OUT_DIR = process.env.OUT_DIR ?? "./mev-capture-extract";
const POOLS_JSON = process.env.POOLS_JSON ?? "";
const CHUNK = Number(process.env.GET_LOGS_RANGE ?? "10000");
// Blocks scanned past the last window so the donation of the last in-window
// accrual (made at the pool's next touch) is seen.
const TAIL_BLOCKS = Number(process.env.TAIL_BLOCKS ?? "7200");
const WINDOWS = [
  { name: "quiet", from: "2026-08-08T00:00:00Z", to: "2026-08-16T00:00:00Z" },
  { name: "volatile", from: "2026-08-17T00:00:00Z", to: "2026-08-27T00:00:00Z" },
];

type RawLog = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  blockHash: Hex;
  removed?: boolean;
};

let rpcId = 0;
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      });
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result as T;
    } catch (error) {
      if (attempt >= 5) throw error;
      await Bun.sleep(1000 * 2 ** attempt);
    }
  }
}

const primary = () => RPC_URLS[0]!;
const hex = (n: number | bigint) => `0x${n.toString(16)}`;

async function blockTimestamp(n: number): Promise<number> {
  const block = await rpc<{ timestamp: Hex }>(primary(), "eth_getBlockByNumber", [hex(n), false]);
  return Number(block.timestamp);
}

// First block whose timestamp is >= ts.
async function firstBlockAtOrAfter(ts: number, lo: number, hi: number): Promise<number> {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockTimestamp(mid)) >= ts) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function logDigest(logs: RawLog[]): string {
  const canonical = logs.map((l) =>
    [l.blockNumber, l.blockHash, l.transactionHash, l.transactionIndex, l.logIndex, l.address.toLowerCase(), l.topics.join(":"), l.data].join("|"),
  );
  return createHash("sha256").update(canonical.join("\n")).digest("hex");
}

async function getLogsVerified(from: number, to: number): Promise<{ logs: RawLog[]; digest: string }> {
  const results = await Promise.all(
    RPC_URLS.map((url) =>
      rpc<RawLog[]>(url, "eth_getLogs", [{ address: CORE, fromBlock: hex(from), toBlock: hex(to) }]),
    ),
  );
  const digests = results.map(logDigest);
  if (new Set(digests).size !== 1) {
    throw new Error(`RPCs disagree on logs ${from}-${to}: ${digests.join(" ")}`);
  }
  return { logs: results[0]!, digest: digests[0]! };
}

function parsePoolState(word: Hex) {
  const v = BigInt(word);
  return {
    sqrtRatio: floatSqrtRatioToFixed(v >> 160n),
    tick: Number(toSigned((v >> 128n) & 0xffffffffn, 32)),
    liquidity: v & ((1n << 128n) - 1n),
  };
}

function parseMevCaptureState(word: Hex) {
  const v = BigInt(word);
  return {
    lastUpdateTime: Number(v >> 224n),
    tickLast: Number(toSigned(v & 0xffffffffn, 32)),
  };
}

type PoolMeta = {
  poolId: Hex;
  token0: Hex;
  token1: Hex;
  config: Hex;
  fee: bigint;
  tickSpacing: number;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
};

async function erc20(token: Hex, selector: Hex): Promise<Hex> {
  return rpc<Hex>(primary(), "eth_call", [{ to: token, data: selector }, "latest"]);
}

async function tokenMeta(token: Hex): Promise<{ decimals: number; symbol: string }> {
  if (BigInt(token) === 0n) return { decimals: 18, symbol: "ETH" };
  const decimals = Number(BigInt(await erc20(token, "0x313ce567")));
  const raw = await erc20(token, "0x95d89b41");
  let symbol = "";
  try {
    const len = Number(BigInt(`0x${raw.slice(66, 130)}`));
    symbol = Buffer.from(raw.slice(130, 130 + len * 2), "hex").toString("utf8");
  } catch {
    symbol = raw;
  }
  return { decimals, symbol };
}

async function loadPools(): Promise<PoolMeta[]> {
  const listed = JSON.parse(readFileSync(POOLS_JSON, "utf8")) as {
    pool_id: Hex;
    pool_key: { token0: Hex; token1: Hex; config: Hex };
  }[];
  const pools: PoolMeta[] = [];
  for (const p of listed) {
    const token0 = `0x${BigInt(p.pool_key.token0).toString(16).padStart(40, "0")}` as Hex;
    const token1 = `0x${BigInt(p.pool_key.token1).toString(16).padStart(40, "0")}` as Hex;
    const config = p.pool_key.config;
    const poolId = toPoolId({ token0, token1, config });
    if (BigInt(poolId) !== BigInt(p.pool_id)) throw new Error(`pool id mismatch ${p.pool_id}`);
    const parsed = parseV2PoolKeyConfig(config);
    if (!("tickSpacing" in parsed)) throw new Error(`not concentrated ${poolId}`);
    if (BigInt(parsed.extension) !== BigInt(MEV_CAPTURE)) throw new Error(`not MEVCapture ${poolId}`);
    const [m0, m1] = await Promise.all([tokenMeta(token0), tokenMeta(token1)]);
    pools.push({
      poolId, token0, token1, config,
      fee: BigInt(parsed.fee), tickSpacing: Number(parsed.tickSpacing),
      decimals0: m0.decimals, decimals1: m1.decimals, symbol0: m0.symbol, symbol1: m1.symbol,
    });
  }
  return pools;
}

function position(l: RawLog) {
  return {
    blockNumber: Number(l.blockNumber),
    transactionIndex: Number(l.transactionIndex),
    logIndex: Number(l.logIndex),
    transactionHash: l.transactionHash,
  };
}

function decodeTopicLog(l: RawLog): { poolId: Hex; event: MevCapturePoolEvent } | null {
  const decoded = decodeEventLog({ abi: CORE_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
  if (decoded.eventName === "FeesAccumulated") {
    const a = decoded.args;
    return { poolId: a.poolId, event: { ...position(l), kind: "fees_accumulated", amount0: a.amount0, amount1: a.amount1 } };
  }
  if (decoded.eventName === "PositionUpdated") {
    const a = decoded.args;
    const state = parsePoolState(a.stateAfter);
    return {
      poolId: a.poolId,
      event: { ...position(l), kind: "position", liquidityDelta: a.liquidityDelta, tickAfter: state.tick, liquidityAfter: state.liquidity },
    };
  }
  return null;
}

function decodeLog(l: RawLog): { poolId: Hex; event: MevCapturePoolEvent } | null {
  if (l.topics.length > 0) return decodeTopicLog(l);
  const s = parseSwapEventV3(l.data);
  return {
    poolId: s.poolId,
    event: {
      ...position(l), kind: "swap", locker: s.locker, delta0: s.delta0, delta1: s.delta1,
      tickAfter: s.tickAfter, liquidityAfter: s.liquidityAfter, sqrtRatioAfter: s.sqrtRatioAfter,
    },
  };
}

async function isMevCapturePool(poolId: Hex, block: number): Promise<boolean> {
  const word = await rpc<Hex>(primary(), "eth_getStorageAt", [MEV_CAPTURE, poolId, hex(block)]);
  return BigInt(word) !== 0n;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

type BlockHeader = { timestamp: number; baseFeePerGas: bigint; miner: Hex };
async function headers(blocks: number[]): Promise<Map<number, BlockHeader>> {
  const map = new Map<number, BlockHeader>();
  await mapLimit(blocks, 8, async (n) => {
    const b = await rpc<{ timestamp: Hex; baseFeePerGas: Hex; miner: Hex }>(primary(), "eth_getBlockByNumber", [hex(n), false]);
    map.set(n, { timestamp: Number(b.timestamp), baseFeePerGas: BigInt(b.baseFeePerGas), miner: b.miner });
  });
  return map;
}

type TxFacts = { from: Hex; to: Hex | null; gasUsed: bigint; effectiveGasPrice: bigint; maxPriorityFeePerGas: bigint | null; type: string };
async function txFacts(hashes: Hex[]): Promise<Map<Hex, TxFacts>> {
  const map = new Map<Hex, TxFacts>();
  await mapLimit([...new Set(hashes)], 8, async (h) => {
    const [tx, receipt] = await Promise.all([
      rpc<{ from: Hex; to: Hex | null; maxPriorityFeePerGas?: Hex; type: Hex }>(primary(), "eth_getTransactionByHash", [h]),
      rpc<{ gasUsed: Hex; effectiveGasPrice: Hex }>(primary(), "eth_getTransactionReceipt", [h]),
    ]);
    map.set(h, {
      from: tx.from, to: tx.to, type: tx.type,
      gasUsed: BigInt(receipt.gasUsed), effectiveGasPrice: BigInt(receipt.effectiveGasPrice),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : null,
    });
  });
  return map;
}

function csv(rows: (string | number | bigint | boolean | null)[][]): string {
  return rows.map((r) => r.map((v) => (v === null ? "" : String(v))).join(",")).join("\n") + "\n";
}

type WindowBlocks = { name: string; fromTs: number; toTs: number; fromBlock: number; toBlock: number };
function windowOf(windows: WindowBlocks[], block: number): string | null {
  for (const w of windows) if (block >= w.fromBlock && block < w.toBlock) return w.name;
  return null;
}

async function resolveWindows(): Promise<WindowBlocks[]> {
  const head = Number(await rpc<Hex>(primary(), "eth_blockNumber", []));
  const out: WindowBlocks[] = [];
  for (const w of WINDOWS) {
    const fromTs = Date.parse(w.from) / 1000;
    const toTs = Date.parse(w.to) / 1000;
    const fromBlock = await firstBlockAtOrAfter(fromTs, 0, head);
    const toBlock = await firstBlockAtOrAfter(toTs, fromBlock, head);
    out.push({ name: w.name, fromTs, toTs, fromBlock, toBlock });
  }
  return out;
}

async function scanLogs(from: number, to: number) {
  const logs: RawLog[] = [];
  const chunks: { from: number; to: number; logs: number; sha256: string }[] = [];
  for (let start = from; start <= to; start += CHUNK) {
    const end = Math.min(to, start + CHUNK - 1);
    const r = await getLogsVerified(start, end);
    if (r.logs.some((l) => l.removed)) throw new Error(`removed log in ${start}-${end}`);
    logs.push(...r.logs);
    chunks.push({ from: start, to: end, logs: r.logs.length, sha256: r.digest });
    console.error(`logs ${start}-${end}: ${r.logs.length}`);
  }
  logs.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  return { logs, chunks };
}

// Pools that swapped in the scan and are MEVCapture pools on chain but are not
// in the supplied list make the inventory incomplete; fail loudly.
async function checkInventory(byPool: Map<Hex, MevCapturePoolEvent[]>, pools: PoolMeta[], atBlock: number) {
  const known = new Set(pools.map((p) => BigInt(p.poolId)));
  const unknownSwapping = [...byPool.entries()]
    .filter(([id, events]) => !known.has(BigInt(id)) && events.some((e) => e.kind === "swap"))
    .map(([id]) => id);
  const flags = await mapLimit(unknownSwapping, 8, (id) => isMevCapturePool(id, atBlock));
  const missing = unknownSwapping.filter((_, i) => flags[i]);
  if (missing.length) throw new Error(`MEVCapture pools missing from POOLS_JSON: ${missing.join(" ")}`);
  for (const p of pools) {
    if (!(await isMevCapturePool(p.poolId, atBlock))) console.error(`not initialized at ${atBlock}: ${p.poolId}`);
  }
  return unknownSwapping.length;
}

function groupByPool(logs: RawLog[]) {
  const byPool = new Map<Hex, MevCapturePoolEvent[]>();
  for (const l of logs) {
    const d = decodeLog(l);
    if (!d) continue;
    const key = d.poolId.toLowerCase() as Hex;
    const list = byPool.get(key) ?? [];
    list.push(d.event);
    byPool.set(key, list);
  }
  return byPool;
}

async function initialState(pool: PoolMeta, block: number) {
  const [core, ext] = await Promise.all([
    rpc<Hex>(primary(), "eth_getStorageAt", [CORE, pool.poolId, hex(block)]),
    rpc<Hex>(primary(), "eth_getStorageAt", [MEV_CAPTURE, pool.poolId, hex(block)]),
  ]);
  return { core: parsePoolState(core), ext: parseMevCaptureState(ext), raw: { core, ext } };
}

const SWAP_HEADER = [
  "chain_id", "pool_id", "window", "block_number", "block_timestamp", "transaction_index", "log_index",
  "transaction_hash", "locker", "delta0", "delta1", "tick_before", "tick_after", "tick_last",
  "liquidity_before", "liquidity_after", "sqrt_ratio_after_x128", "base_fee0", "base_fee1",
  "additional_fee_x64", "surcharge_exact_in_estimate0", "surcharge_exact_in_estimate1", "is_first_touch",
];

function swapCsvRow(s: SwapRow, window: string, ts: number) {
  return [
    CHAIN_ID, s.poolId, window, s.blockNumber, ts, s.transactionIndex, s.logIndex, s.transactionHash,
    s.locker, s.delta0, s.delta1, s.tickBefore, s.tickAfter, s.tickLast, s.liquidityBefore,
    s.liquidityAfter, s.sqrtRatioAfter, s.baseFee0, s.baseFee1, s.additionalFee,
    s.surchargeExactIn0, s.surchargeExactIn1, s.isFirstTouch,
  ];
}

const BLOCK_HEADER = [
  "chain_id", "pool_id", "window", "block_number", "block_timestamp", "base_fee_per_gas", "fee_recipient", "swaps",
  "amount_in0", "amount_in1", "amount_out0", "amount_out1", "base_fee0", "base_fee1",
  "surcharge0", "surcharge1", "surcharge_status", "surcharge_donation_block", "surcharge_donation_tx",
  "surcharge_exact_in_estimate0", "surcharge_exact_in_estimate1", "tick_last", "tick_after_last_swap",
  "liquidity_before_first_swap", "liquidity_after_last_swap",
  "first_touch_tx_hash", "first_touch_tx_index", "first_touch_log_index", "first_touch_locker",
  "first_touch_delta0", "first_touch_delta1", "first_touch_tick_after", "first_touch_tx_from", "first_touch_tx_to",
  "first_touch_tx_type", "first_touch_gas_used", "first_touch_effective_gas_price",
  "first_touch_max_priority_fee_per_gas", "first_touch_priority_fee_per_gas", "first_touch_priority_fee_paid_wei",
];

function surchargeStatus(b: BlockRow) {
  if (b.surcharge0 !== null) return "donated";
  const est = b.surchargeEstimate0 + b.surchargeEstimate1;
  return est === 0n ? "none_accrued" : "pending_after_scan";
}

function txColumns(tx: TxFacts | undefined, h: BlockHeader) {
  if (!tx) return [null, null, null, null, null, null, null, null];
  const priority = tx.effectiveGasPrice - h.baseFeePerGas;
  return [
    tx.from, tx.to, tx.type, tx.gasUsed, tx.effectiveGasPrice, tx.maxPriorityFeePerGas,
    priority, priority * tx.gasUsed,
  ];
}

function blockCsvRow(b: BlockRow, window: string, h: BlockHeader, tx: TxFacts | undefined) {
  const f = b.firstTouch;
  return [
    CHAIN_ID, b.poolId, window, b.blockNumber, h.timestamp, h.baseFeePerGas, h.miner, b.swaps,
    b.amountIn0, b.amountIn1, b.amountOut0, b.amountOut1, b.baseFee0, b.baseFee1,
    b.surcharge0 ?? 0n, b.surcharge1 ?? 0n, surchargeStatus(b), b.donationBlockNumber, b.donationTransactionHash,
    b.surchargeEstimate0, b.surchargeEstimate1, b.tickLast, b.tickAfterLastSwap,
    b.liquidityBeforeFirstSwap, b.liquidityAfterLastSwap,
    f.transactionHash, f.transactionIndex, f.logIndex, f.locker, f.delta0, f.delta1, f.tickAfter,
    ...txColumns(tx, h),
  ];
}

type Summary = Record<string, bigint | number>;
function emptySummary(): Summary {
  return {
    swaps: 0, blocks_with_swaps: 0, amount_in0: 0n, amount_in1: 0n, amount_out0: 0n, amount_out1: 0n,
    base_fee0: 0n, base_fee1: 0n, surcharge0: 0n, surcharge1: 0n, surcharge_estimate0: 0n, surcharge_estimate1: 0n,
    blocks_surcharge_pending: 0, blocks_surcharge_mismatch: 0,
  };
}

function addBlockToSummary(s: Summary, b: BlockRow) {
  const add = (k: string, v: bigint) => (s[k] = (s[k] as bigint) + v);
  s.swaps = (s.swaps as number) + b.swaps;
  s.blocks_with_swaps = (s.blocks_with_swaps as number) + 1;
  add("amount_in0", b.amountIn0); add("amount_in1", b.amountIn1);
  add("amount_out0", b.amountOut0); add("amount_out1", b.amountOut1);
  add("base_fee0", b.baseFee0); add("base_fee1", b.baseFee1);
  add("surcharge0", b.surcharge0 ?? 0n); add("surcharge1", b.surcharge1 ?? 0n);
  add("surcharge_estimate0", b.surchargeEstimate0); add("surcharge_estimate1", b.surchargeEstimate1);
  if (surchargeStatus(b) === "pending_after_scan") s.blocks_surcharge_pending = (s.blocks_surcharge_pending as number) + 1;
  if (b.surcharge0 !== null && !surchargeMatches(b)) s.blocks_surcharge_mismatch = (s.blocks_surcharge_mismatch as number) + 1;
}

// The donation leaves one wei behind in a token the first time it is used, and
// computeFee rounds up per swap; allow a few wei per swap.
function surchargeMatches(b: BlockRow) {
  const tol = BigInt(b.swaps + 1);
  const d0 = (b.surcharge0 ?? 0n) - b.surchargeEstimate0;
  const d1 = (b.surcharge1 ?? 0n) - b.surchargeEstimate1;
  return d0 <= tol && d0 >= -tol && d1 <= tol && d1 >= -tol;
}

function hourlyRows(pool: PoolMeta, tracker: MevCapturePoolTracker, w: WindowBlocks, hdr: Map<number, BlockHeader>, initialLiquidity: bigint) {
  const points = tracker.liquidityPoints.map((p) => ({ timestamp: hdr.get(p.blockNumber)!.timestamp, liquidity: p.liquidity }));
  const rows: (string | number | bigint | boolean | null)[][] = [];
  for (let t = w.fromTs; t < w.toTs; t += 3600) {
    const s = emptySummary();
    for (const b of tracker.blocks.values()) {
      const ts = hdr.get(b.blockNumber)!.timestamp;
      if (ts >= t && ts < t + 3600) addBlockToSummary(s, b);
    }
    rows.push([
      CHAIN_ID, pool.poolId, w.name, new Date(t * 1000).toISOString(), t,
      liquidityAt(initialLiquidity, points, t), timeWeightedLiquidity(initialLiquidity, points, t, t + 3600),
      s.swaps!, s.blocks_with_swaps!, s.amount_in0!, s.amount_in1!, s.amount_out0!, s.amount_out1!,
      s.base_fee0!, s.base_fee1!, s.surcharge0!, s.surcharge1!, s.blocks_surcharge_pending!,
    ]);
  }
  return rows;
}

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type Tracked = { pool: PoolMeta; tracker: MevCapturePoolTracker; initial: Awaited<ReturnType<typeof initialState>> };

async function replay(pools: PoolMeta[], byPool: Map<Hex, MevCapturePoolEvent[]>, snapshotBlock: number): Promise<Tracked[]> {
  const trackers: Tracked[] = [];
  for (const pool of pools) {
    const initial = await initialState(pool, snapshotBlock);
    const tracker = new MevCapturePoolTracker(
      { poolId: pool.poolId, fee: pool.fee, tickSpacing: pool.tickSpacing },
      { tick: initial.core.tick, liquidity: initial.core.liquidity },
    );
    for (const e of byPool.get(pool.poolId.toLowerCase() as Hex) ?? []) tracker.apply(e);
    trackers.push({ pool, tracker, initial });
  }
  return trackers;
}

function eventBlocksOf(trackers: Tracked[]) {
  const blocks = new Set<number>();
  for (const { tracker } of trackers) {
    for (const b of tracker.blocks.keys()) blocks.add(b);
    for (const p of tracker.liquidityPoints) blocks.add(p.blockNumber);
  }
  return [...blocks].sort((a, b) => a - b);
}

const HOURLY_HEADER = [
  "chain_id", "pool_id", "window", "hour_start_utc", "hour_start_ts", "active_liquidity_at_hour_start",
  "active_liquidity_time_weighted", "swaps", "blocks_with_swaps", "amount_in0", "amount_in1", "amount_out0",
  "amount_out1", "base_fee0", "base_fee1", "surcharge0", "surcharge1", "blocks_surcharge_pending",
];
const SUMMARY_HEADER = [
  "chain_id", "pool_id", "token0", "token1", "symbol0", "symbol1", "decimals0", "decimals1", "fee_x64", "tick_spacing",
  "window", "from_utc", "to_utc", "from_block", "to_block_exclusive", "active_liquidity_at_start",
  "active_liquidity_time_weighted", "swaps", "blocks_with_swaps", "first_touch_swaps", "amount_in0", "amount_in1",
  "amount_out0", "amount_out1", "base_fee0", "base_fee1", "surcharge0", "surcharge1", "surcharge_exact_in_estimate0",
  "surcharge_exact_in_estimate1", "blocks_surcharge_pending", "blocks_surcharge_estimate_mismatch",
  "carry_in_donations0", "carry_in_donations1",
];
const CARRY_HEADER = ["chain_id", "pool_id", "window", "block_number", "transaction_hash", "log_index", "amount0", "amount1"];

type Row = unknown[];
type Outputs = { swaps: Row[]; blocks: Row[]; hourly: Row[]; summary: Row[]; carryIn: Row[] };

function summaryRow(t: Tracked, w: WindowBlocks, windows: WindowBlocks[], hdr: Map<number, BlockHeader>, carry: CarryInDonation[]): Row {
  const { pool, tracker, initial } = t;
  const s = emptySummary();
  for (const b of tracker.blocks.values()) if (windowOf(windows, b.blockNumber) === w.name) addBlockToSummary(s, b);
  const points = tracker.liquidityPoints.map((p) => ({ timestamp: hdr.get(p.blockNumber)!.timestamp, liquidity: p.liquidity }));
  return [
    CHAIN_ID, pool.poolId, pool.token0, pool.token1, pool.symbol0, pool.symbol1, pool.decimals0, pool.decimals1,
    pool.fee, pool.tickSpacing, w.name, new Date(w.fromTs * 1000).toISOString(), new Date(w.toTs * 1000).toISOString(),
    w.fromBlock, w.toBlock, liquidityAt(initial.core.liquidity, points, w.fromTs),
    timeWeightedLiquidity(initial.core.liquidity, points, w.fromTs, w.toTs),
    s.swaps, s.blocks_with_swaps, s.blocks_with_swaps, s.amount_in0, s.amount_in1, s.amount_out0, s.amount_out1,
    s.base_fee0, s.base_fee1, s.surcharge0, s.surcharge1, s.surcharge_estimate0, s.surcharge_estimate1,
    s.blocks_surcharge_pending, s.blocks_surcharge_mismatch,
    carry.reduce((a, d) => a + d.amount0, 0n), carry.reduce((a, d) => a + d.amount1, 0n),
  ];
}

function collectPool(t: Tracked, windows: WindowBlocks[], hdr: Map<number, BlockHeader>, tx: Map<Hex, TxFacts>, out: Outputs) {
  const { pool, tracker, initial } = t;
  for (const s of tracker.swaps) {
    const w = windowOf(windows, s.blockNumber);
    if (w) out.swaps.push(swapCsvRow(s, w, hdr.get(s.blockNumber)!.timestamp));
  }
  for (const b of tracker.blocks.values()) {
    const w = windowOf(windows, b.blockNumber);
    if (w) out.blocks.push(blockCsvRow(b, w, hdr.get(b.blockNumber)!, tx.get(b.firstTouch.transactionHash)));
  }
  for (const w of windows) {
    const carry = tracker.carryInDonations.filter((d) => windowOf(windows, d.blockNumber) === w.name);
    for (const d of carry) out.carryIn.push([CHAIN_ID, pool.poolId, w.name, d.blockNumber, d.transactionHash, d.logIndex, d.amount0, d.amount1]);
    out.summary.push(summaryRow(t, w, windows, hdr, carry));
    out.hourly.push(...hourlyRows(pool, tracker, w, hdr, initial.core.liquidity));
  }
}

function writeOutputs(out: Outputs, manifest: object) {
  const files: Record<string, Row[]> = {
    "mev_capture_window_summary.csv": [SUMMARY_HEADER, ...out.summary],
    "mev_capture_blocks.csv": [BLOCK_HEADER, ...out.blocks],
    "mev_capture_swaps.csv": [SWAP_HEADER, ...out.swaps],
    "mev_capture_hourly.csv": [HOURLY_HEADER, ...out.hourly],
    "mev_capture_carry_in_donations.csv": [CARRY_HEADER, ...out.carryIn],
  };
  for (const [name, rows] of Object.entries(files)) writeFileSync(join(OUT_DIR, name), csv(rows as never));
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const names = [...Object.keys(files), "manifest.json"];
  writeFileSync(join(OUT_DIR, "SHA256SUMS"), names.map((n) => `${sha256File(join(OUT_DIR, n))}  ${n}`).join("\n") + "\n");
}

async function main() {
  if (RPC_URLS.length < 2) throw new Error("RPC_URLS needs at least two providers to cross-check logs");
  mkdirSync(OUT_DIR, { recursive: true });
  const windows = await resolveWindows();
  const scanFrom = windows[0]!.fromBlock;
  const scanTo = windows[windows.length - 1]!.toBlock - 1 + TAIL_BLOCKS;
  const snapshotBlock = scanFrom - 1;
  console.error(JSON.stringify({ windows, scanFrom, scanTo }));

  const pools = await loadPools();
  const { logs, chunks } = await scanLogs(scanFrom, scanTo);
  const byPool = groupByPool(logs);
  const nonListedSwappingPools = await checkInventory(byPool, pools, scanTo);
  const trackers = await replay(pools, byPool, snapshotBlock);

  const hdr = await headers(eventBlocksOf(trackers));
  const inWindow = trackers.flatMap(({ tracker }) => [...tracker.blocks.values()].filter((b) => windowOf(windows, b.blockNumber)));
  const tx = await txFacts(inWindow.map((b) => b.firstTouch.transactionHash));

  const out: Outputs = { swaps: [], blocks: [], hourly: [], summary: [], carryIn: [] };
  for (const t of trackers) collectPool(t, windows, hdr, tx, out);

  writeOutputs(out, {
    generatedAt: new Date().toISOString(),
    sourceSha256: Object.fromEntries(
      ["scripts/extractMevCaptureSeries.ts", "src/evm/mevCaptureSeries.ts", "src/evm/swapEvent.ts", "src/evm/abis_v3.ts"].map(
        (f) => [f, sha256File(join(import.meta.dir, "..", f))],
      ),
    ),
    chainId: CHAIN_ID, core: CORE, mevCapture: MEV_CAPTURE,
    rpcHosts: RPC_URLS.map((u) => new URL(u).host),
    windows, scanFrom, scanTo, tailBlocks: TAIL_BLOCKS, snapshotBlock,
    getLogsChunks: chunks, coreLogsScanned: logs.length,
    nonListedSwappingPoolsCheckedNotMevCapture: nonListedSwappingPools,
    pools: trackers.map(({ pool, initial }) => ({
      ...pool, fee: pool.fee.toString(),
      snapshot: {
        block: snapshotBlock, coreWord: initial.raw.core, mevCaptureWord: initial.raw.ext, ...initial.ext,
        tick: initial.core.tick, liquidity: initial.core.liquidity.toString(),
      },
    })),
  });
  console.error("done");
}

await main();
