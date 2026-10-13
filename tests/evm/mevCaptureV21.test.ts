import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { encodeAbiParameters, encodeFunctionResult, type Hex } from "viem";
import gateData from "../data/mevcapture-v21/gateScenarios.json";
import anchorData from "../data/mevcapture-v21/anchorUpdates.json";
import vectorData from "../data/mevcapture-v21-main/v21-main-quoter-vectors.json";
import { createClient, ensureIndexerCursor } from "../helpers/db";
import { createPgliteDao } from "../helpers/pgliteDao";
import type { DAO } from "../../src/_shared/dao";
import {
  ANCHOR_GATE_FAILED_TOPIC,
  GET_CONFIG_CALLDATA,
  MEV_CAPTURE_V21_ABI,
  createMevCaptureV21GateProcessor,
  decodeMevCaptureV21Anchor,
  decodeMevCaptureV21Config,
  encodeMevCaptureV21Anchor,
  loadMevCaptureV21Address,
  parseAnchorGateFailed,
  recordMevCaptureV21BlockState,
  type MevCaptureV21Anchor,
  type MevCaptureV21Config,
} from "../../src/evm/mevCaptureV21";

const CHAIN_ID = 1;
const CORE: Hex = "0x00000000000000000000000000000000000c0e00";
const EXT: Hex = "0x0000000000000000000000000000000000021000";
const OTHER: Hex = "0x0000000000000000000000000000000000000bad";

type Strings<T> = { [K in keyof T]: string };

function toAnchor(s: Strings<MevCaptureV21Anchor>): MevCaptureV21Anchor {
  return {
    lastUpdateTime: Number(s.lastUpdateTime),
    lRefTime: Number(s.lRefTime),
    lastPosTime: Number(s.lastPosTime),
    lRefBits: Number(s.lRefBits),
    snapBits: Number(s.snapBits),
    lRefRaiseTime: Number(s.lRefRaiseTime),
    anchorX16: BigInt(s.anchorX16),
  };
}

// The gate fixtures come from the `next` build, whose anchor/gate code is
// identical; their tuple is mapped onto the main getConfig (Q0.16 maxFee to
// Q0.64, no maxSegments).
const CONFIG: MevCaptureV21Config = {
  halfLife: Number(gateData.config.halfLife),
  slopeK: Number(gateData.config.slopeK),
  segmentExp: Number(gateData.config.segmentExp),
  segmentWidthMultiplier: 2 ** Number(gateData.config.segmentExp),
  jLin: Number(gateData.config.jLin),
  maxFee: BigInt(gateData.config.maxFee) << 48n,
  clampTicks: Number(gateData.config.clampTicks),
  mGate: Number(gateData.config.mGate),
};
const hex32 = (n: number | bigint) =>
  `0x${BigInt(n).toString(16).padStart(64, "0")}` as Hex;
const blockHash = (n: number) => hex32(0xb10c00000000n + BigInt(n));

function gateLog(poolId: Hex, lObs: number, eRef: number) {
  return {
    topics: [ANCHOR_GATE_FAILED_TOPIC, poolId] as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint8" }, { type: "uint8" }],
      [lObs, eRef],
    ),
  };
}

// eth_call answers keyed by block hash; anything unexpected throws, so a read
// at the wrong block or of the wrong contract fails the test.
class FakeRpc {
  anchors = new Map<string, Hex>();
  calls: { to: Hex; data: Hex; blockHash: Hex }[] = [];
  request = (async ({ method, params }: { method: string; params: any[] }) => {
    if (method !== "eth_call") throw new Error(`unexpected ${method}`);
    const [{ to, data }, block] = params;
    if (!block?.blockHash || block.requireCanonical !== true) {
      throw new Error("eth_call not pinned to a canonical block hash");
    }
    this.calls.push({ to, data, blockHash: block.blockHash });
    if (BigInt(to) !== BigInt(EXT)) throw new Error(`call to ${to}`);
    if (data === GET_CONFIG_CALLDATA) {
      return encodeFunctionResult({
        abi: MEV_CAPTURE_V21_ABI,
        functionName: "getConfig",
        result: CONFIG,
      });
    }
    const answer = this.anchors.get(`${block.blockHash}:${data.slice(10)}`);
    if (!answer) throw new Error(`no anchor for ${block.blockHash}`);
    return answer;
  }) as any;
  setAnchor(hash: Hex, poolId: Hex, anchor: MevCaptureV21Anchor) {
    this.anchors.set(
      `${hash}:${poolId.slice(2)}`,
      encodeMevCaptureV21Anchor(anchor),
    );
  }
}

let client: PGlite;
let dao: DAO;
let nextPoolId = 1;

beforeAll(async () => {
  client = await createClient();
  await ensureIndexerCursor(client, CHAIN_ID);
  dao = createPgliteDao(client, BigInt(CHAIN_ID));
});

afterAll(async () => {
  await client.close();
});

async function insertBlock(n: number, time: number) {
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, to_timestamp($4), 1)`,
    [CHAIN_ID, n, BigInt(blockHash(n)).toString(), time],
  );
}

function key(n: number, eventIndex = 0, emitter: Hex = CORE) {
  return {
    blockNumber: n,
    transactionIndex: 0,
    eventIndex,
    emitter,
    transactionHash: hex32(n * 1000 + eventIndex),
  };
}

const eventCols = `chain_id, block_number, transaction_index, event_index, transaction_hash, emitter`;
const eventVals = (n: number, i: number) => [
  CHAIN_ID,
  n,
  0,
  i,
  (n * 1000 + i).toString(),
  BigInt(CORE).toString(),
];

async function createPool(n: number, time: number, extension: Hex = EXT) {
  const poolId = hex32(0x9000 + nextPoolId++);
  await insertBlock(n, time);
  const {
    rows: [{ pool_key_id }],
  } = await client.query<{ pool_key_id: string }>(
    `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
       fee_denominator, tick_spacing, pool_extension)
     VALUES ($1, $2, $3, 1, 2, 100, 18446744073709551616, 1, $4)
     RETURNING pool_key_id`,
    [
      CHAIN_ID,
      BigInt(CORE).toString(),
      BigInt(poolId).toString(),
      BigInt(extension).toString(),
    ],
  );
  await client.query(
    `INSERT INTO pool_initializations (${eventCols}, pool_key_id, tick, sqrt_ratio)
     VALUES ($1,$2,$3,$4,$5,$6,$7, 0, 79228162514264337593543950336)`,
    [...eventVals(n, 0), pool_key_id],
  );
  return { poolId, poolKeyId: pool_key_id };
}

async function insertSwap(n: number, i: number, poolKeyId: string, liquidityAfter: string) {
  await client.query(
    `INSERT INTO swaps (${eventCols}, pool_key_id, locker, delta0, delta1,
       sqrt_ratio_after, tick_after, liquidity_after, block_time)
     SELECT $1,$2,$3,$4,$5,$6,$7, 1, 0, 0, 79228162514264337593543950336, 0, $8, block_time
     FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [...eventVals(n, i), poolKeyId, liquidityAfter],
  );
}

async function insertCoreSwap(
  n: number,
  tx: number,
  i: number,
  poolKeyId: string,
  locker: Hex,
  delta0: string,
  delta1: string,
) {
  await client.query(
    `INSERT INTO swaps (${eventCols}, pool_key_id, locker, delta0, delta1,
       sqrt_ratio_after, tick_after, liquidity_after, block_time)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, 79228162514264337593543950336, 0, 1, block_time
     FROM blocks WHERE chain_id = $1 AND block_number = $2`,
    [CHAIN_ID, n, tx, i, (n * 1000 + tx).toString(), BigInt(CORE).toString(), poolKeyId,
     BigInt(locker).toString(), delta0, delta1],
  );
}

async function insertFeesAccumulated(n: number, tx: number, i: number, poolKeyId: string, fee0: string, fee1: string) {
  await client.query(
    `INSERT INTO fees_accumulated (${eventCols}, pool_key_id, delta0, delta1)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [CHAIN_ID, n, tx, i, (n * 1000 + tx).toString(), BigInt(CORE).toString(), poolKeyId, fee0, fee1],
  );
}

async function surchargeRows(n: number) {
  const { rows } = await client.query<any>(
    `SELECT transaction_index, pool_key_id::text, first_event_id::text, last_event_id::text,
            core_calls, charged_calls, core_delta0::text, core_delta1::text,
            surcharge0::text, surcharge1::text, delta0::text, delta1::text
     FROM mev_capture_v21_swap_surcharges WHERE chain_id = $1 AND block_number = $2
     ORDER BY mev_capture_v21_swap_surcharges.first_event_id`,
    [CHAIN_ID, n],
  );
  return rows;
}

async function insertPositionTouch(n: number, i: number, poolKeyId: string) {
  // Zero delta: only marks the pool as touched in this block.
  await client.query(
    `INSERT INTO position_updates (${eventCols}, pool_key_id, locker, salt,
       lower_bound, upper_bound, liquidity_delta, delta0, delta1)
     VALUES ($1,$2,$3,$4,$5,$6,$7, 1, 0, -10, 10, 0, 0, 0)`,
    [...eventVals(n, i), poolKeyId],
  );
}

async function anchorRows(poolKeyId: string) {
  const { rows } = await client.query<any>(
    `SELECT block_number, last_update_time, l_ref_time, last_pos_time, l_ref_bits,
            snap_bits, l_ref_raise_time, anchor_x16::text AS anchor_x16
     FROM mev_capture_v21_anchor_states WHERE pool_key_id = $1 ORDER BY block_number`,
    [poolKeyId],
  );
  return rows;
}

function asRow(a: MevCaptureV21Anchor) {
  return {
    last_update_time: String(a.lastUpdateTime),
    l_ref_time: String(a.lRefTime),
    last_pos_time: String(a.lastPosTime),
    l_ref_bits: a.lRefBits,
    snap_bits: a.snapBits,
    l_ref_raise_time: String(a.lRefRaiseTime),
    anchor_x16: a.anchorX16.toString(),
  };
}

function normalize(row: any) {
  const { block_number: _, ...rest } = row;
  return Object.fromEntries(
    Object.entries(rest).map(([k, v]) => [
      k,
      k === "l_ref_bits" || k === "snap_bits" ? Number(v) : String(v),
    ]),
  );
}

async function health(asOf: number) {
  const { rows } = await client.query<any>(
    `SELECT * FROM mev_capture_v21_pool_health($1, to_timestamp($2))`,
    [CHAIN_ID, asOf],
  );
  const byPool = new Map(rows.map((r) => [String(r.pool_key_id), r]));
  return { get: (poolKeyId: unknown) => byPool.get(String(poolKeyId)) };
}

const processor = createMevCaptureV21GateProcessor(EXT, CORE);
const record = (rpc: FakeRpc, n: number) =>
  recordMevCaptureV21BlockState({
    rpc,
    dao,
    extension: EXT,
    coreAddress: CORE,
    blockNumber: n,
    blockHash: blockHash(n),
  });

describe("decoding", () => {
  test("anchor vectors round-trip through the merged ABI", () => {
    for (const row of anchorData.anchorUpdates) {
      for (const s of [row.stateIn, row.expected]) {
        const anchor = toAnchor(s);
        expect(decodeMevCaptureV21Anchor(encodeMevCaptureV21Anchor(anchor))).toEqual(anchor);
      }
    }
  });

  test("getConfig decodes the vector config and rejects impossible ones", () => {
    const encode = (c: MevCaptureV21Config) =>
      encodeFunctionResult({ abi: MEV_CAPTURE_V21_ABI, functionName: "getConfig", result: c });
    expect(decodeMevCaptureV21Config(encode(CONFIG))).toEqual(CONFIG);
    expect(() => decodeMevCaptureV21Config(encode({ ...CONFIG, segmentWidthMultiplier: 2 }))).toThrow();
    expect(() => decodeMevCaptureV21Config(encode({ ...CONFIG, maxFee: (1n << 63n) + 1n }))).toThrow();
    expect(() => decodeMevCaptureV21Config(encode({ ...CONFIG, maxFee: 0n }))).toThrow();
    expect(decodeMevCaptureV21Config(encode({ ...CONFIG, maxFee: 1n << 63n })).maxFee).toBe(1n << 63n);
    expect(() => decodeMevCaptureV21Config(encode({ ...CONFIG, halfLife: 0 }))).toThrow();
    expect(() => decodeMevCaptureV21Config(encode({ ...CONFIG, mGate: 17 }))).toThrow();
    // a dirty high byte in a uint8 word is not truncated into a plausible value
    const dirty = encode(CONFIG).split("");
    dirty[2 + 64 + 2] = "f";
    expect(() => decodeMevCaptureV21Config(dirty.join("") as Hex)).toThrow();
  });

  test("AnchorGateFailed: indexed poolId, strict address, topic and layout", () => {
    const poolId = hex32(42);
    const log = { address: EXT, ...gateLog(poolId, 7, 12) };
    expect(parseAnchorGateFailed(EXT, log)).toEqual({ poolId, lObs: 7, eRef: 12 });
    // another version / lookalike emitter
    expect(() => parseAnchorGateFailed(EXT, { ...log, address: OTHER })).toThrow();
    // wrong selector
    expect(() => parseAnchorGateFailed(EXT, { ...log, topics: [hex32(1), poolId] })).toThrow();
    // poolId not indexed (data carries three words)
    expect(() =>
      parseAnchorGateFailed(EXT, {
        address: EXT,
        topics: [ANCHOR_GATE_FAILED_TOPIC],
        data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "uint8" }], [poolId, 7, 12]),
      }),
    ).toThrow();
    // extra indexed topic
    expect(() => parseAnchorGateFailed(EXT, { ...log, topics: [...log.topics, hex32(1)] })).toThrow();
    // dirty uint8 and short data
    expect(() => parseAnchorGateFailed(EXT, { ...log, data: encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }], [256n, 1]) })).toThrow();
    expect(() => parseAnchorGateFailed(EXT, { ...log, data: log.data.slice(0, 66) as Hex })).toThrow();
  });

  test("v2.1 address must not be a v1 MEVCapture address", () => {
    expect(loadMevCaptureV21Address(undefined, [OTHER])).toBeUndefined();
    expect(loadMevCaptureV21Address(EXT, [OTHER, undefined])).toBe(EXT);
    expect(() => loadMevCaptureV21Address(EXT, [EXT.toUpperCase().replace("0X", "0x") as Hex])).toThrow();
  });
});

let blockCursor = 1000;

type Scenario = (typeof gateData.gateScenarios)[number];

// Replays one golden gate scenario as the processor sees it: one block per
// step, Core touch rows, AnchorGateFailed from the extension on every failed
// first-of-timestamp swap, and getAnchor answered with the vector's expected
// post-step state at that block's hash.
async function replay(scenario: Scenario, rpc: FakeRpc, checkHealth: boolean) {
  const initial = toAnchor(scenario.initial);
  const init = ++blockCursor;
  const { poolId, poolKeyId } = await createPool(init, initial.lastUpdateTime);
  await dao.insertMEVCaptureV21Pool(EXT, poolId, key(init));
  rpc.setAnchor(blockHash(init), poolId, initial);
  expect(await record(rpc, init)).toBe(1);

  const expected = [asRow(initial)];
  let failures = 0;
  for (const step of scenario.steps) {
    const n = ++blockCursor;
    const time = Number(step.timestamp);
    if (checkHealth && step.op === "swap" && step.first) {
      // The SQL decayed reference equals the contract's eRef for this swap.
      const h = (await health(time)).get(poolKeyId);
      expect(h?.e_ref_now).toBe(Number(step.eRef));
    }
    await insertBlock(n, time);
    if (step.op === "swap" && step.first && !step.passed) {
      await processor.handler(dao, key(n, 0, EXT), gateLog(poolId, Number(step.lObs), Number(step.eRef)));
      failures++;
    }
    if (step.op === "swap") await insertSwap(n, 1, poolKeyId, step.liquidityAfter);
    else await insertPositionTouch(n, 1, poolKeyId);
    const anchor = toAnchor(step.expected);
    rpc.setAnchor(blockHash(n), poolId, anchor);
    expect(await record(rpc, n)).toBe(1);
    expected.push(asRow(anchor));
  }
  return { poolId, poolKeyId, expected, failures, init };
}

describe("replay of merged-contract gate scenarios", () => {
  test("all 24 scenarios: every anchor field and every gate failure is stored", async () => {
    const rpc = new FakeRpc();
    let steps = 0;
    let gateFailures = 0;
    for (const scenario of gateData.gateScenarios) {
      const { poolKeyId, expected, failures } = await replay(scenario, rpc, true);
      expect((await anchorRows(poolKeyId)).map(normalize)).toEqual(expected);
      const { rows } = await client.query<{ n: string; l: string; e: string }>(
        `SELECT count(*) AS n FROM mev_capture_v21_gate_failures WHERE pool_key_id = $1`,
        [poolKeyId],
      );
      expect(Number(rows[0]!.n)).toBe(failures);
      steps += scenario.steps.length;
      gateFailures += failures;
    }
    expect(steps).toBe(1785);
    expect(gateFailures).toBe(943);
    // getConfig is read once per extension, never per pool or block
    expect(rpc.calls.filter((c) => c.data === GET_CONFIG_CALLDATA)).toHaveLength(1);
    const { rows } = await client.query<any>(
      `SELECT half_life, slope_k, segment_exp, segment_width_multiplier, j_lin,
              max_fee::text, clamp_ticks, m_gate
       FROM mev_capture_v21_configs`,
    );
    expect(rows.map((r) => Object.values(r).map(String))).toEqual([Object.values(CONFIG).map(String)]);
  }, 120_000);

  test("SQL bit length matches the contract's lObs", async () => {
    const cases = anchorData.anchorUpdates.filter(
      (r) => r.stateIn.lastPosTime !== r.timestamp,
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const r of cases) {
      const { rows } = await client.query<{ b: number }>(
        `SELECT mev_capture_v21_bit_length($1::numeric) AS b`,
        [r.liquidity],
      );
      expect(rows[0]!.b).toBe(Number(r.lObs));
    }
    for (const [x, b] of [["0", 0], ["1", 1], ["2", 2], ["255", 8], ["256", 9], [(2n ** 128n - 1n).toString(), 128]] as const) {
      const { rows } = await client.query<{ b: number }>(`SELECT mev_capture_v21_bit_length($1::numeric) AS b`, [x]);
      expect(rows[0]!.b).toBe(b);
    }
  });

  test("reorg rollback removes orphaned anchors and gate failures; replay restores them", async () => {
    const scenario = gateData.gateScenarios.find((s) => s.name === "q1_idle_drop_6_bits_restore")!;
    const rpc = new FakeRpc();
    const { poolId, poolKeyId, expected, init } = await replay(scenario, rpc, false);
    const before = await client.query<any>(
      `SELECT block_number, event_index, l_obs, e_ref FROM mev_capture_v21_gate_failures
       WHERE pool_key_id = $1 ORDER BY event_id`,
      [poolKeyId],
    );
    expect(before.rows.length).toBeGreaterThan(0);
    const cut = Number(before.rows[0].block_number);

    await dao.deleteOldBlockNumbers(cut);
    const kept = await anchorRows(poolKeyId);
    expect(kept.map(normalize)).toEqual(expected.slice(0, cut - init));
    const gone = await client.query(`SELECT 1 FROM mev_capture_v21_gate_failures WHERE pool_key_id = $1`, [poolKeyId]);
    expect(gone.rows).toHaveLength(0);

    // the canonical chain re-delivers the same blocks
    const steps = scenario.steps.slice(cut - init - 1);
    let n = cut - 1;
    for (const step of steps) {
      n++;
      await insertBlock(n, Number(step.timestamp));
      if (step.op === "swap" && step.first && !step.passed) {
        await processor.handler(dao, key(n, 0, EXT), gateLog(poolId, Number(step.lObs), Number(step.eRef)));
      }
      if (step.op === "swap") await insertSwap(n, 1, poolKeyId, step.liquidityAfter);
      else await insertPositionTouch(n, 1, poolKeyId);
      await record(rpc, n);
    }
    expect((await anchorRows(poolKeyId)).map(normalize)).toEqual(expected);
    const after = await client.query<any>(
      `SELECT block_number, event_index, l_obs, e_ref FROM mev_capture_v21_gate_failures
       WHERE pool_key_id = $1 ORDER BY event_id`,
      [poolKeyId],
    );
    expect(after.rows).toEqual(before.rows);
  }, 60_000);
});

describe("guards", () => {
  test("a duplicate gate event is rejected, not double counted", async () => {
    const n = ++blockCursor;
    const { poolId } = await createPool(n, 1_700_000_000);
    await dao.insertMEVCaptureV21Pool(EXT, poolId, key(n));
    const log = gateLog(poolId, 1, 9);
    await processor.handler(dao, key(n, 1, EXT), log);
    await expect(processor.handler(dao, key(n, 1, EXT), log)).rejects.toThrow();
  });

  test("gate events for pools that are not v2.1 pools of the emitter fail the block", async () => {
    const n = ++blockCursor;
    // a pool on another extension (e.g. v1 MEVCapture) is never registered
    const { poolId } = await createPool(n, 1_700_000_000, OTHER);
    await expect(dao.insertMEVCaptureV21Pool(EXT, poolId, key(n))).rejects.toThrow();
    await expect(processor.handler(dao, key(n, 1, EXT), gateLog(poolId, 1, 9))).rejects.toThrow();
    await expect(processor.handler(dao, key(n, 2, EXT), gateLog(hex32(0xdead), 1, 9))).rejects.toThrow();
    // emitted by a different contract than the configured extension
    await expect(processor.handler(dao, key(n, 3, OTHER), gateLog(poolId, 1, 9))).rejects.toThrow();
  });

  test("a gate-only block (no Core log) still reads the anchor", async () => {
    const init = ++blockCursor;
    const { poolId, poolKeyId } = await createPool(init, 1_700_000_000);
    await dao.insertMEVCaptureV21Pool(EXT, poolId, key(init));
    const rpc = new FakeRpc();
    const a = toAnchor(gateData.gateScenarios[0]!.initial);
    rpc.setAnchor(blockHash(init), poolId, a);
    await record(rpc, init);
    const n = ++blockCursor;
    await insertBlock(n, 1_700_000_100);
    await processor.handler(dao, key(n, 0, EXT), gateLog(poolId, 1, 9));
    const b = { ...a, lastUpdateTime: 1_700_000_100 };
    rpc.setAnchor(blockHash(n), poolId, b);
    expect(await record(rpc, n)).toBe(1);
    expect((await anchorRows(poolKeyId)).map(normalize)).toEqual([asRow(a), asRow(b)]);
  });

  test("a failed read fails the block instead of writing a gap", async () => {
    const n = ++blockCursor;
    const { poolId } = await createPool(n, 1_700_000_000);
    await dao.insertMEVCaptureV21Pool(EXT, poolId, key(n));
    await expect(record(new FakeRpc(), n)).rejects.toThrow();
  });

  test("health flags anchors older than 2*tau and counts failures in the window", async () => {
    const init = ++blockCursor;
    const t0 = 1_800_000_000;
    const { poolId, poolKeyId } = await createPool(init, t0);
    await dao.insertMEVCaptureV21Pool(EXT, poolId, key(init));
    const rpc = new FakeRpc();
    const anchor = { lastUpdateTime: t0, lRefTime: t0, lastPosTime: 0, lRefBits: 40, snapBits: 0, lRefRaiseTime: t0 - CONFIG.halfLife, anchorX16: 0n };
    rpc.setAnchor(blockHash(init), poolId, anchor);
    await record(rpc, init);
    const n = ++blockCursor;
    await insertBlock(n, t0 + 10);
    await processor.handler(dao, key(n, 0, EXT), gateLog(poolId, 30, 40));
    await insertSwap(n, 1, poolKeyId, (2n ** 35n).toString());
    rpc.setAnchor(blockHash(n), poolId, { ...anchor, lastUpdateTime: t0 + 10 });
    await record(rpc, n);

    const tau = CONFIG.halfLife;
    const fresh = (await health(t0 + 10 + 2 * tau)).get(poolKeyId);
    expect(fresh.stale_anchor).toBe(false);
    // the window is (as_of - 2*tau, as_of]: exactly 2*tau old is outside
    expect(Number(fresh.gate_failures_2tau)).toBe(0);
    const inWindow = (await health(t0 + 9 + 2 * tau)).get(poolKeyId);
    expect(Number(inWindow.gate_failures_2tau)).toBe(1);
    expect(fresh.liquidity_bits_now).toBe(36);
    // eRef decays one bit per elapsed tau since lRefTime
    expect(fresh.e_ref_now).toBe(40 - Math.floor((10 + 2 * tau) / tau));
    expect(fresh.gate_margin_now).toBe(36 + CONFIG.mGate - fresh.e_ref_now);
    const stale = (await health(t0 + 10 + 2 * tau + 1)).get(poolKeyId);
    expect(stale.stale_anchor).toBe(true);
    expect(Number(stale.last_gate_failure_block)).toBe(n);
  });
});

type Vector = (typeof vectorData.vectors)[number];

// Writes a vector's Core logs as Core emits them inside one forward: Swapped
// per call (locker = extension), FeesAccumulated right after each charged call
// with a nonzero fee.
async function writeVector(n: number, tx: number, firstIndex: number, poolKeyId: string, v: Vector) {
  let i = firstIndex;
  for (const c of v.calls) {
    await insertCoreSwap(n, tx, i++, poolKeyId, EXT, c.delta0, c.delta1);
    if (c.fee0 !== "0" || c.fee1 !== "0") {
      await insertFeesAccumulated(n, tx, i++, poolKeyId, c.fee0, c.fee1);
    }
  }
  return i;
}

describe("per-swap surcharge attribution (main-variant contract vectors)", () => {
  test("all 21 vectors: one row per forward with the contract's totals", async () => {
    expect(vectorData.branch).toBe("eku-1582/mevcapture-v21-main");
    expect(vectorData.vectors).toHaveLength(21);
    let calls = 0;
    for (const v of vectorData.vectors) {
      const n = ++blockCursor;
      const { poolId, poolKeyId } = await createPool(n, 1_700_000_000);
      await dao.insertMEVCaptureV21Pool(EXT, poolId, key(n));
      const end = await writeVector(n, 1, 0, poolKeyId, v);
      expect(await dao.insertMEVCaptureV21SwapSurcharges(EXT, CORE, n)).toBe(1);
      const sum = (f: (c: Vector["calls"][number]) => string) =>
        v.calls.reduce((t, c) => t + BigInt(f(c)), 0n).toString();
      const charged = v.calls.filter((c) => c.fee0 !== "0" || c.fee1 !== "0");
      const [row] = await surchargeRows(n);
      expect(row).toEqual({
        transaction_index: 1,
        pool_key_id: poolKeyId.toString(),
        first_event_id: row.first_event_id,
        last_event_id: row.last_event_id,
        core_calls: v.calls.length,
        charged_calls: charged.length,
        core_delta0: sum((c) => c.delta0),
        core_delta1: sum((c) => c.delta1),
        surcharge0: sum((c) => c.fee0),
        surcharge1: sum((c) => c.fee1),
        // the forward's returned balance update
        delta0: v.total.delta0,
        delta1: v.total.delta1,
      });
      // the last Swapped of the forward; a trailing FeesAccumulated is after it
      const lastSwapIndex = end - 1 - (charged.includes(v.calls.at(-1)!) ? 1 : 0);
      expect(BigInt(row.last_event_id) - BigInt(row.first_event_id)).toBe(BigInt(lastSwapIndex));
      // the surcharge is on the calculated token only
      expect(v.params.isToken1 ? row.surcharge1 : row.surcharge0).toBe("0");
      calls += v.calls.length;
    }
    expect(calls).toBe(266);
  }, 60_000);

  test("forwards split by other pools' swaps; the same pool twice in a transaction is two rows", async () => {
    const vs = vectorData.vectors;
    const a = vs.find((v) => v.name === "inc_exact_in_cut_bridge_rate")!;
    const b = vs.find((v) => v.name === "dec_exact_out_partial")!;
    const n = ++blockCursor;
    const { poolId, poolKeyId } = await createPool(n, 1_700_000_000);
    await dao.insertMEVCaptureV21Pool(EXT, poolId, key(n));
    const other = await client.query<{ pool_key_id: string }>(
      `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
         fee_denominator, tick_spacing, pool_extension)
       VALUES ($1, $2, $3, 2, 3, 100, 18446744073709551616, 1, 0) RETURNING pool_key_id`,
      [CHAIN_ID, BigInt(CORE).toString(), BigInt(hex32(0xbeef + n)).toString()],
    );
    const otherKey = other.rows[0]!.pool_key_id;
    let i = await writeVector(n, 0, 0, poolKeyId, a);
    // a hop through a pool without the extension, then the v2.1 pool again
    await insertCoreSwap(n, 0, i++, otherKey, OTHER, "5", "-4");
    i = await writeVector(n, 0, i, poolKeyId, b);
    // a separate transaction in the same block
    await writeVector(n, 3, 0, poolKeyId, a);
    expect(await dao.insertMEVCaptureV21SwapSurcharges(EXT, CORE, n)).toBe(3);
    const rows = await surchargeRows(n);
    expect(rows.map((r) => [r.transaction_index, r.core_calls, r.delta0, r.delta1])).toEqual([
      [0, a.calls.length, a.total.delta0, a.total.delta1],
      [0, b.calls.length, b.total.delta0, b.total.delta1],
      [3, a.calls.length, a.total.delta0, a.total.delta1],
    ]);
  });

  test("a FeesAccumulated that does not follow the extension's Swapped fails the block", async () => {
    const n = ++blockCursor;
    const { poolId, poolKeyId } = await createPool(n, 1_700_000_000);
    await dao.insertMEVCaptureV21Pool(EXT, poolId, key(n));
    await insertFeesAccumulated(n, 0, 0, poolKeyId, "1", "0");
    await expect(dao.insertMEVCaptureV21SwapSurcharges(EXT, CORE, n)).rejects.toThrow(/does not follow/);
    const m = ++blockCursor;
    await insertBlock(m, 1_700_000_100);
    // the pool's previous Swapped is in another transaction
    await insertCoreSwap(m, 0, 0, poolKeyId, EXT, "1", "-1");
    await insertFeesAccumulated(m, 1, 0, poolKeyId, "1", "0");
    await expect(dao.insertMEVCaptureV21SwapSurcharges(EXT, CORE, m)).rejects.toThrow(/does not follow/);
  });

  test("recorded with the block state", async () => {
    const v = vectorData.vectors.find((x) => x.name === "bridge_25pct_exact_in")!;
    const n = ++blockCursor;
    const { poolId, poolKeyId } = await createPool(n, 1_700_000_000);
    await dao.insertMEVCaptureV21Pool(EXT, poolId, key(n));
    await writeVector(n, 1, 0, poolKeyId, v);
    const rpc = new FakeRpc();
    rpc.setAnchor(blockHash(n), poolId, toAnchor(gateData.gateScenarios[0]!.initial));
    expect(await record(rpc, n)).toBe(1);
    const [row] = await surchargeRows(n);
    const fee0 = v.calls.reduce((t, c) => t + BigInt(c.fee0), 0n).toString();
    expect([row.surcharge0, row.delta0, row.delta1]).toEqual([fee0, v.total.delta0, v.total.delta1]);
    // a reorg removes it with the block
    await dao.deleteOldBlockNumbers(n);
    expect(await surchargeRows(n)).toHaveLength(0);
  });
});
