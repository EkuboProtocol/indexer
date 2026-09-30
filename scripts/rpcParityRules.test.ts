import { describe, expect, it } from "bun:test";
import {
  classifyHeadSample,
  diffLogs,
  evaluateDrift,
  isEmptyDiff,
  recommendSuspectLogCount,
  verdict,
  type ParityReport,
  type RawLog,
} from "./rpcParityRules";

const log = (block: number, index: number, over: Partial<RawLog> = {}): RawLog => ({
  address: "0x00000000000014aA86C5d3c41765bb24e11bd701",
  blockHash: `0x${block.toString(16).padStart(64, "0")}`,
  blockNumber: `0x${block.toString(16)}`,
  data: "0xAB",
  logIndex: `0x${index.toString(16)}`,
  topics: ["0x01"],
  transactionHash: "0xfeed",
  transactionIndex: "0x0",
  ...over,
});

describe("diffLogs", () => {
  it("ignores hex case and padding", () => {
    const a = [log(10, 1)];
    const b = [log(10, 1, { address: a[0]!.address.toLowerCase(), data: "0xab", logIndex: "0x01", transactionIndex: "0x00" })];
    expect(isEmptyDiff(diffLogs(a, b))).toBe(true);
  });

  it("reports a missing, an extra and a changed log", () => {
    const diff = diffLogs([log(10, 1), log(11, 0)], [log(11, 0, { data: "0xcd" }), log(12, 3)]);
    expect(diff).toEqual({ onlyPrimary: ["10:1"], onlyCandidate: ["12:3"], changed: ["11:0"] });
  });

  it("counts a duplicated log as a difference", () => {
    expect(isEmptyDiff(diffLogs([log(10, 1)], [log(10, 1), log(10, 1)]))).toBe(false);
  });
});

describe("classifyHeadSample", () => {
  const hash = "0xaa";
  const sample = { head: 12, headHash: hash, servedHash: hash, from: 8, logs: [log(10, 1)] };

  it("matches when the final chain has the same head and logs", () => {
    expect(classifyHeadSample(sample, "0xAA", [log(10, 1)]).outcome).toBe("match");
  });

  it("treats a head that is not final as a reorg, whatever the logs", () => {
    expect(classifyHeadSample(sample, "0xbb", []).outcome).toBe("reorg");
  });

  it("fails logs short of a final head: the behind-node read", () => {
    const result = classifyHeadSample({ ...sample, logs: [] }, hash, [log(10, 1)]);
    expect(result.outcome).toBe("mismatch");
    expect(result.diff?.onlyPrimary).toEqual(["10:1"]);
  });

  it("fails a head block the candidate could not serve by number", () => {
    expect(classifyHeadSample({ ...sample, servedHash: null }, hash, [log(10, 1)]).outcome).toBe("mismatch");
  });

  it("fails an unserved head even when that head was later reorged out", () => {
    expect(classifyHeadSample({ ...sample, servedHash: null }, "0xbb", []).outcome).toBe("mismatch");
  });

  it("counts a head replaced between latest and the by-number read as a reorg", () => {
    expect(classifyHeadSample({ ...sample, servedHash: "0xcc" }, "0xbb", []).outcome).toBe("reorg");
  });
});

describe("evaluateDrift", () => {
  const limits = { maxBlocks: 3, maxSeconds: 3 };

  it("gates on p95, reporting the maximum", () => {
    const samples = [...Array(99)].map(() => ({ blocks: 1, seconds: 1 })).concat({ blocks: 40, seconds: 20 });
    expect(evaluateDrift(samples, limits)).toMatchObject({ ok: true, p95Blocks: 1, maxBlocks: 40 });
  });

  it("passes many blocks of drift on a fast chain when the time is small", () => {
    expect(evaluateDrift([{ blocks: -12, seconds: -2 }], limits).ok).toBe(true);
  });

  it("fails a candidate that lags in both", () => {
    expect(evaluateDrift([{ blocks: 10, seconds: 20 }], limits).ok).toBe(false);
  });

  it("fails with no samples", () => {
    expect(evaluateDrift([], limits).ok).toBe(false);
  });
});

describe("recommendSuspectLogCount", () => {
  it("keeps the documented cap when every result matched", () => {
    const probes = [
      { blocks: 1, primary: 300, candidate: 300 },
      { blocks: 2, primary: 700, candidate: 700 },
      { blocks: 4, primary: "error" as const, candidate: "error" as const },
    ];
    expect(recommendSuspectLogCount(probes, 10_000)).toEqual({ suspectLogCount: 10_000, silentTruncation: null, largestIntact: 700 });
  });

  it("uses the count at which the candidate returned fewer logs without an error", () => {
    const probes = [
      { blocks: 16, primary: 6_000, candidate: 6_000 },
      { blocks: 32, primary: 9_500, candidate: 5_000 },
    ];
    expect(recommendSuspectLogCount(probes, 10_000)).toMatchObject({ suspectLogCount: 5_000, silentTruncation: "shortfall" });
  });

  it("recognises a plateau once the primary refuses the span", () => {
    const probes = [
      { blocks: 32, primary: "error" as const, candidate: 10_000 },
      { blocks: 64, primary: "error" as const, candidate: 10_000 },
    ];
    expect(recommendSuspectLogCount(probes, 20_000)).toMatchObject({ suspectLogCount: 10_000, silentTruncation: "plateau" });
  });
});

describe("verdict", () => {
  const passing: ParityReport = {
    chainIdOk: true,
    finalized: { ok: true, detail: "" },
    windows: { compared: 24, eventBearing: 20, failures: [] },
    head: { reads: 300, errors: 8, match: 290, reorg: 2, mismatch: 0, nonEmpty: 12, timedOut: false },
    drift: evaluateDrift([{ blocks: 1, seconds: 1 }], { maxBlocks: 3, maxSeconds: 3 }),
    cap: { suspectLogCount: 10_000, silentTruncation: null, largestIntact: 9_000 },
  };

  it("fails on silent truncation, even a stable plateau", () => {
    const cap = { suspectLogCount: 10_000, silentTruncation: "plateau" as const, largestIntact: 9_000 };
    expect(verdict({ ...passing, cap }).reasons).toEqual(["silent eth_getLogs truncation (plateau) at 10000 logs"]);
  });

  it("passes a clean report", () => {
    expect(verdict(passing)).toEqual({ pass: true, reasons: [] });
  });

  it("fails on a single differing near-head read", () => {
    expect(verdict({ ...passing, head: { ...passing.head, mismatch: 1 } }).pass).toBe(false);
  });

  it("fails when finality never arrived, rather than passing unchecked reads", () => {
    expect(verdict({ ...passing, head: { ...passing.head, match: 0, reorg: 0, timedOut: true } }).pass).toBe(false);
  });

  it("fails a candidate that errors on more than 5% of head reads", () => {
    expect(verdict({ ...passing, head: { ...passing.head, errors: 16 } }).reasons).toEqual(["16 of 300 near-head reads errored (limit 5%)"]);
  });

  it("fails when no compared window had events: empty agreement proves nothing", () => {
    expect(verdict({ ...passing, windows: { compared: 3, eventBearing: 0, failures: [] } }).pass).toBe(false);
  });

  it("fails a differing window", () => {
    expect(verdict({ ...passing, windows: { ...passing.windows, failures: ["1..1000"] } }).pass).toBe(false);
  });
});
