/**
 * Decides whether a candidate RPC endpoint may join a chain's `EVM_RPC_URL`
 * list behind the primary (EKU-527). Read-only against both endpoints.
 *
 *   NETWORK=ink-mainnet PARITY_PRIMARY_URL=<alchemy> PARITY_CANDIDATE_URL=<drpc> \
 *     bun scripts/rpcParity.ts
 *
 * `StickyRpc` keeps every read of a loop turn on one endpoint, so a candidate
 * only has to be right on its own. What it must never do is the silent failure:
 * answer `eth_getLogs` from a node that is behind, with fewer events and no
 * error. dRPC routes each request by upstream height
 * (https://github.com/drpcorg/dshackle#readme: "It considers nodes locations,
 * state, current height ... If upstream lags behind others ... Dshackle
 * temporarily excludes it"), and this checks that claim for our queries rather
 * than taking it:
 *
 * 1. `eth_getLogs` with the production address set at GET_LOGS_RANGE_SIZE over
 *    finalized, event-bearing windows spread across the indexed history must
 *    be identical on both endpoints.
 * 2. PARITY_HEAD_READS near-head reads from the candidate -- `latest`, the
 *    block by number, and the logs up to it, as the stream reads them -- are
 *    re-read from the primary once finalized. A head that was reorged out is
 *    counted, not failed; any other difference fails.
 * 3. The candidate's `finalized` tag answers, with the primary's hash.
 *    More than PARITY_MAX_HEAD_ERROR_PCT of them erroring also fails: loud,
 *    but a secondary that cannot read at the head cannot carry the indexer.
 * 4. `latest` on both, read together, drifts by at most PARITY_MAX_DRIFT_BLOCKS
 *    or PARITY_MAX_DRIFT_SECONDS at p95.
 * 5. The candidate's real `eth_getLogs` range and result caps are measured, and
 *    the result cap becomes its SUSPECT_LOG_COUNT entry. Silent truncation
 *    fails the chain: admitting one with a measured cap is a review decision.
 *
 * Prints JSON lines and a final `summary` line with the verdict and the
 * SUSPECT_LOG_COUNT to use; appends a table to $GITHUB_STEP_SUMMARY when set.
 * Exits 1 when the chain fails, and a failed chain stays on the primary alone.
 * Endpoint URLs carry keys, so every message goes through `redactSecrets`.
 */
import { appendFileSync } from "node:fs";
import { createPublicClient, http, numberToHex, type Address, type PublicClient } from "viem";
import { redactSecrets } from "../src/_shared/redactSecrets";
import { loadConfig } from "../src/config";
import { createEvmProcessors } from "../src/evm";
import {
  classifyHeadSample,
  diffLogs,
  evaluateDrift,
  isEmptyDiff,
  recommendSuspectLogCount,
  verdict,
  type CapProbe,
  type DriftSample,
  type HeadSample,
  type ParityReport,
  type RawLog,
} from "./rpcParityRules";

loadConfig("evm");

const PRIMARY_URL = required("PARITY_PRIMARY_URL");
const CANDIDATE_URL = required("PARITY_CANDIDATE_URL");
const secrets = { EVM_RPC_URL: `${PRIMARY_URL},${CANDIDATE_URL}` };
// The shared logger's crash handler redacts against process.env, so a throw
// this script does not catch -- a primary outage mid-run -- would otherwise be
// covered only by the key patterns (CSO, EKU-529).
process.env.EVM_RPC_URL = secrets.EVM_RPC_URL;
const CHAIN_ID = BigInt(required("CHAIN_ID"));
const RANGE = int("GET_LOGS_RANGE_SIZE", 1_000);
const START = int("STARTING_CURSOR_BLOCK_NUMBER", 0) + 1;
const WINDOWS = int("PARITY_WINDOWS", 24);
const HEAD_READS = int("PARITY_HEAD_READS", 300);
const HEAD_INTERVAL_MS = int("PARITY_HEAD_INTERVAL_MS", 2_000);
const HEAD_SPAN = int("PARITY_HEAD_SPAN", 5);
const FINALITY_TIMEOUT_MS = int("PARITY_FINALITY_TIMEOUT_MINUTES", 90) * 60_000;
const MAX_DRIFT_BLOCKS = int("PARITY_MAX_DRIFT_BLOCKS", 3);
const MAX_DRIFT_SECONDS = int("PARITY_MAX_DRIFT_SECONDS", 3);
const MAX_HEAD_ERROR_PCT = int("PARITY_MAX_HEAD_ERROR_PCT", 5);
// dRPC's documented eth_getLogs result cap.
const DOCUMENTED_CAP = int("PARITY_DOCUMENTED_LOG_CAP", 10_000);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const addresses = [
  ...new Set(createEvmProcessors().map((processor) => processor.address.toLowerCase() as Address)),
];
const primary = client(PRIMARY_URL);
const candidate = client(CANDIDATE_URL);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function client(url: string): PublicClient {
  return createPublicClient({ transport: http(url, { retryCount: 3, timeout: 60_000 }) });
}

const redact = (text: string) => redactSecrets(text, secrets);
/** viem's short message and the provider's own words, without the request dump. */
function errorText(error: unknown): string {
  const e = error as { shortMessage?: string; details?: string; message?: string };
  const text = e?.shortMessage ? [e.shortMessage, e.details].filter(Boolean).join(": ") : (e?.message ?? String(error));
  return redact(text).slice(0, 300);
}
const emit = (line: Record<string, unknown>) => console.log(redact(JSON.stringify(line)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getLogs(rpc: PublicClient, from: number, to: number, filter: { address?: Address[]; topics?: string[] } = { address: addresses }) {
  return (await rpc.request({
    method: "eth_getLogs",
    params: [{ fromBlock: numberToHex(BigInt(from)), toBlock: numberToHex(BigInt(to)), ...filter }],
  } as never)) as unknown as RawLog[];
}

type Header = { number: number; hash: string; timestamp: number };

async function block(rpc: PublicClient, tag: "latest" | "finalized" | number): Promise<Header | null> {
  const raw = (await rpc.request({
    method: "eth_getBlockByNumber",
    params: [typeof tag === "number" ? numberToHex(BigInt(tag)) : tag, false],
  } as never)) as unknown as { number: string; hash: string; timestamp: string } | null;
  return raw && { number: Number(BigInt(raw.number)), hash: raw.hash, timestamp: Number(BigInt(raw.timestamp)) };
}

// --- 0. chain id --------------------------------------------------------------

const [primaryChainId, candidateChainId] = await Promise.all([primary.getChainId(), candidate.getChainId()]);
const chainIdOk = BigInt(primaryChainId) === CHAIN_ID && BigInt(candidateChainId) === CHAIN_ID;
emit({ kind: "chain_id", expected: CHAIN_ID.toString(), primary: primaryChainId, candidate: candidateChainId, ok: chainIdOk });

// --- 3. finalized tag -----------------------------------------------------------

async function checkFinalized(): Promise<ParityReport["finalized"] & { number: number }> {
  const [ours, theirs] = await Promise.all([block(primary, "finalized"), block(candidate, "finalized").catch((e) => e as Error)]);
  if (!ours) throw new Error("primary has no finalized block");
  if (theirs instanceof Error) return { ok: false, detail: `candidate errored: ${errorText(theirs)}`, number: ours.number };
  if (!theirs) return { ok: false, detail: "candidate returned null", number: ours.number };
  const reference = await block(primary, theirs.number);
  const ok = reference?.hash.toLowerCase() === theirs.hash.toLowerCase();
  const detail = `candidate ${theirs.number} (${ours.number - theirs.number} behind the primary's), hash ${ok ? "matches" : "differs"}`;
  return { ok, detail, number: Math.min(ours.number, theirs.number) };
}

const finalized = await checkFinalized();
emit({ kind: "finalized", ...finalized });
const settled = finalized.number;

// --- 1. getLogs windows ---------------------------------------------------------

/**
 * The most recent event in [lo, hi], found on the primary by growing the span
 * backwards from `hi`: a chain that is busy answers in one call, and one with
 * a few dozen events in its history takes a few dozen at most.
 */
async function latestEventIn(lo: number, hi: number): Promise<number | null> {
  let span = RANGE;
  while (hi >= lo) {
    const from = Math.max(lo, hi - span + 1);
    let logs: RawLog[];
    try {
      logs = await getLogs(primary, from, hi);
    } catch (error) {
      if (span <= RANGE) throw error;
      span = Math.max(RANGE, Math.floor(span / 4));
      continue;
    }
    if (logs.length) return Math.max(...logs.map((log) => Number(BigInt(log.blockNumber))));
    hi = from - 1;
    span *= 4;
  }
  return null;
}

/** The stream's own alignment: ranges of GET_LOGS_RANGE_SIZE from the start block. */
const windowOf = (blockNumber: number): [number, number] => {
  const from = START + Math.floor((blockNumber - START) / RANGE) * RANGE;
  return [from, Math.min(settled, from + RANGE - 1)];
};

const windows = new Map<number, number>([[windowOf(settled)[0], windowOf(settled)[1]]]);
const segment = Math.max(RANGE, Math.ceil((settled - START + 1) / WINDOWS));
for (let hi = settled; hi >= START && windows.size <= WINDOWS; hi -= segment) {
  const found = await latestEventIn(Math.max(START, hi - segment + 1), hi);
  if (found !== null) {
    const [from, to] = windowOf(found);
    windows.set(from, to);
  }
}

const windowReport: ParityReport["windows"] = { compared: 0, eventBearing: 0, failures: [] };
for (const [from, to] of [...windows].sort(([a], [b]) => a - b)) {
  const ours = await getLogs(primary, from, to);
  let theirs: RawLog[];
  try {
    theirs = await getLogs(candidate, from, to);
  } catch (error) {
    windowReport.failures.push(`${from}..${to}`);
    emit({ kind: "window", from, to, primaryLogs: ours.length, candidateError: errorText(error) });
    continue;
  }
  const diff = diffLogs(ours, theirs);
  windowReport.compared++;
  if (ours.length) windowReport.eventBearing++;
  if (!isEmptyDiff(diff)) windowReport.failures.push(`${from}..${to}`);
  emit({ kind: "window", from, to, primaryLogs: ours.length, candidateLogs: theirs.length, identical: isEmptyDiff(diff), ...(isEmptyDiff(diff) ? {} : { diff }) });
}

// --- 5. range and result caps ---------------------------------------------------

let largestRangeOk = 0;
let rangeError: string | null = null;
for (const blocks of [RANGE, 2_000, 5_000, 10_000, 50_000, 100_000, 1_000_000]) {
  if (blocks > settled - START + 1 || blocks < largestRangeOk) continue;
  try {
    await getLogs(candidate, settled - blocks + 1, settled);
    largestRangeOk = blocks;
  } catch (error) {
    rangeError = `${blocks} blocks: ${errorText(error)}`;
    break;
  }
}
emit({ kind: "range_cap", largestRangeOk, firstFailure: rangeError });

// Token transfers are the densest log stream on any chain; double the span until
// the candidate refuses or returns well past its documented cap.
const capProbes: CapProbe[] = [];
for (let blocks = 1; blocks <= 100_000; blocks *= 2) {
  const count = (rpc: PublicClient) =>
    getLogs(rpc, settled - blocks + 1, settled, { topics: [TRANSFER_TOPIC] }).then((logs) => logs.length, () => "error" as const);
  const [ours, theirs] = await Promise.all([count(primary), count(candidate)]);
  capProbes.push({ blocks, primary: ours, candidate: theirs });
  emit({ kind: "result_cap_probe", blocks, primary: ours, candidate: theirs });
  const previous = capProbes.at(-2)?.candidate;
  if (theirs === "error" || theirs > 2 * DOCUMENTED_CAP || (theirs >= 1_000 && theirs === previous)) break;
}
const cap = recommendSuspectLogCount(capProbes, DOCUMENTED_CAP);
emit({ kind: "result_cap", ...cap });

// --- 2 and 4. near-head reads and drift ------------------------------------------

const samples: HeadSample[] = [];
const drift: DriftSample[] = [];
// Only the candidate's errors count against it; the primary's are reported apart
// and cost that iteration its drift sample, nothing more (CTO, EKU-528).
const headErrors = new Map<string, number>();
const primaryErrors = new Map<string, number>();
const tally = (errors: Map<string, number>, error: unknown) => {
  const text = errorText(error);
  errors.set(text, (errors.get(text) ?? 0) + 1);
};
for (let i = 0; i < HEAD_READS; i++) {
  if (i) await sleep(HEAD_INTERVAL_MS);
  const oursRead = block(primary, "latest").catch((error: unknown) => {
    tally(primaryErrors, error);
    return null;
  });
  try {
    const [ours, theirs] = await Promise.all([oursRead, block(candidate, "latest")]);
    if (!theirs) throw new Error("latest returned null");
    if (ours) drift.push({ blocks: ours.number - theirs.number, seconds: ours.timestamp - theirs.timestamp });
    // In the stream's order: the head, the logs up to it, then its blocks.
    const from = Math.max(START, theirs.number - HEAD_SPAN + 1);
    const logs = await getLogs(candidate, from, theirs.number);
    const served = await block(candidate, theirs.number);
    samples.push({ head: theirs.number, headHash: theirs.hash, servedHash: served?.hash ?? null, from, logs });
  } catch (error) {
    tally(headErrors, error);
  }
}
const driftReport = evaluateDrift(drift, { maxBlocks: MAX_DRIFT_BLOCKS, maxSeconds: MAX_DRIFT_SECONDS });
emit({ kind: "drift", ...driftReport });

const errorCount = [...headErrors.values()].reduce((a, b) => a + b, 0);
for (const [error, count] of headErrors) emit({ kind: "head_read_errors", count, error });
for (const [error, count] of primaryErrors) emit({ kind: "primary_head_read_errors", count, error });
const head: ParityReport["head"] = { reads: HEAD_READS, errors: errorCount, match: 0, reorg: 0, mismatch: 0, nonEmpty: 0, timedOut: false };
const highest = Math.max(0, ...samples.map((s) => s.head));
const deadline = Date.now() + FINALITY_TIMEOUT_MS;
while ((await block(primary, "finalized"))!.number < highest) {
  if (Date.now() > deadline) {
    head.timedOut = true;
    break;
  }
  await sleep(30_000);
}
if (!head.timedOut && samples.length) {
  const lowest = Math.min(...samples.map((s) => s.from));
  const final: RawLog[] = [];
  for (let from = lowest; from <= highest; from += RANGE) {
    final.push(...(await getLogs(primary, from, Math.min(highest, from + RANGE - 1))));
  }
  const hashes = new Map<number, string>();
  for (const sample of samples) {
    if (!hashes.has(sample.head)) hashes.set(sample.head, (await block(primary, sample.head))!.hash);
    const expected = final.filter((log) => {
      const n = Number(BigInt(log.blockNumber));
      return n >= sample.from && n <= sample.head;
    });
    const { outcome, diff } = classifyHeadSample(sample, hashes.get(sample.head)!, expected);
    head[outcome]++;
    if (expected.length) head.nonEmpty++;
    if (outcome === "mismatch") emit({ kind: "head_mismatch", head: sample.head, served: sample.servedHash !== null, diff });
  }
}
emit({ kind: "head_reads", ...head });

// --- verdict --------------------------------------------------------------------

const report: ParityReport = { chainIdOk, finalized, windows: windowReport, head, drift: driftReport, cap };
const result = verdict(report, MAX_HEAD_ERROR_PCT);
emit({ kind: "summary", network: process.env.NETWORK, pass: result.pass, reasons: result.reasons, suspectLogCount: cap.suspectLogCount, largestRangeOk });

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, redact([
    `### ${process.env.NETWORK}: ${result.pass ? "PASS" : "FAIL"}`,
    ...result.reasons.map((reason) => `- ${reason}`),
    "",
    "| check | result |",
    "| --- | --- |",
    `| chain id | ${chainIdOk ? "ok" : "MISMATCH"} |`,
    `| finalized tag | ${finalized.detail} |`,
    `| eth_getLogs windows (${RANGE} blocks, ${addresses.length} addresses) | ${windowReport.compared} compared, ${windowReport.eventBearing} with events, ${windowReport.failures.length} differ/failed |`,
    `| near-head reads | ${head.match} match, ${head.reorg} reorged, ${head.mismatch} differ, ${head.nonEmpty} with events, ${head.errors}/${head.reads} errored${head.timedOut ? ", finality timed out" : ""} |`,
    `| latest drift (p95 / max) | ${driftReport.p95Blocks} / ${driftReport.maxBlocks} blocks, ${driftReport.p95Seconds} / ${driftReport.maxSeconds} s |`,
    `| largest range served | ${largestRangeOk} blocks${rangeError ? `; failed at ${rangeError}` : ""} |`,
    `| SUSPECT_LOG_COUNT | ${cap.suspectLogCount} (${cap.silentTruncation ? `silent truncation (${cap.silentTruncation})` : `largest intact result ${cap.largestIntact}`}) |`,
    "",
  ].join("\n")));
}

process.exit(result.pass ? 0 : 1);
