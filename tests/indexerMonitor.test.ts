import { describe, expect, it } from "bun:test";
import { EXPECTED } from "../infra/indexer-monitor/src/chains";
import {
  GAP_MAX_AGE_MS,
  HEAD_MAX_AGE_MS,
  apply,
  emptyState,
  monitor,
  observations,
  parseReport,
  sameDigest,
  type Expected,
  type State,
} from "../infra/indexer-monitor/src/status";
import { parseGapChains, type Result } from "../scripts/eventGapAudit";
import { evaluate, parseChains, type CursorRow } from "../scripts/headLagRules";
import {
  delayUntilNext,
  gapReport,
  headLagReport,
} from "../scripts/productionMonitorRules";

const expected: Expected = {
  headChains: ["eth", "base"],
  gapChains: ["mainnet", "starknet/mainnet"],
};
const minute = 60_000;
const t0 = Date.UTC(2026, 10, 19, 12);

function feed(reports: [number, unknown][], start: State = emptyState()) {
  return reports.reduce((state, [at, body]) => {
    const report = parseReport(body, at);
    if (!report) throw new Error(`rejected ${JSON.stringify(body)}`);
    return apply(state, report);
  }, start);
}

const headOk = (lagging: string[] = []) => ({
  kind: "head-lag",
  ok: true,
  chains: ["eth", "base"],
  lagging,
});
const headFailed = { kind: "head-lag", ok: false, error: "read_failed" };
const gaps = (outcome: string, other = "ok") => ({
  kind: "event-gaps",
  chains: [
    { chain: "mainnet", outcome },
    { chain: "starknet/mainnet", outcome: other },
  ],
});

describe("receiver", () => {
  it("is healthy on current, clean telemetry", () => {
    const state = feed([
      [t0, headOk()],
      [t0, gaps("ok")],
    ]);
    expect(observations(state, expected)).toEqual({
      status: 200,
      body: "indexer-no-observed-fault",
    });
    expect(monitor(state, expected, t0 + minute)).toEqual({
      status: 200,
      body: "indexer-monitor-current",
    });
  });

  it("opens one lag episode that only a definitive check clears", () => {
    let state = feed([
      [t0, headOk(["base"])],
      [t0, gaps("ok")],
    ]);
    expect(observations(state, expected).body).toBe(
      "indexer-observed-fault head-lag=base",
    );
    // A failed read neither opens nor clears it.
    state = feed([[t0 + minute, headFailed]], state);
    expect(observations(state, expected).status).toBe(503);
    expect(monitor(state, expected, t0 + 2 * minute).status).toBe(200);
    state = feed([[t0 + 2 * minute, headOk()]], state);
    expect(observations(state, expected).status).toBe(200);
  });

  it("tells a failing database read from silence", () => {
    let state = feed([
      [t0, headOk()],
      [t0, gaps("ok")],
    ]);
    state = feed([[t0 + 4 * minute, headFailed]], state);
    const later = t0 + HEAD_MAX_AGE_MS + minute;
    expect(monitor(state, expected, later).body).toBe(
      "indexer-monitor-unavailable head-lag=read-failing",
    );
    expect(
      monitor(state, expected, t0 + 4 * minute + HEAD_MAX_AGE_MS).body,
    ).toBe("indexer-monitor-unavailable head-lag=no-report");
    // Killed before ever reporting.
    expect(monitor(emptyState(), expected, t0).body).toContain(
      "head-lag=no-report",
    );
  });

  it("reports an event gap until the chain is audited clean", () => {
    let state = feed([
      [t0, headOk()],
      [t0, gaps("gap")],
    ]);
    expect(observations(state, expected).body).toBe(
      "indexer-observed-fault event-gap=mainnet",
    );
    state = feed([[t0 + 30 * minute, gaps("check_failed")]], state);
    expect(observations(state, expected).status).toBe(503);
    state = feed([[t0 + 60 * minute, gaps("ok")]], state);
    expect(observations(state, expected).status).toBe(200);
  });

  it("flags repeated gap-check failures and missing chains as telemetry, not gaps", () => {
    let state = feed([[t0, gaps("ok")]]);
    state = feed(
      [
        [t0 + 30 * minute, gaps("check_failed")],
        [t0 + 60 * minute, gaps("check_failed")],
      ],
      state,
    );
    const now = t0 + GAP_MAX_AGE_MS + minute;
    state = feed([[now, headOk()]], state);
    expect(observations(state, expected).status).toBe(200);
    expect(monitor(state, expected, now).body).toBe(
      "indexer-monitor-unavailable event-gap=check-failing:mainnet",
    );
    const partial = feed([
      [t0, headOk()],
      [
        t0,
        { kind: "event-gaps", chains: [{ chain: "mainnet", outcome: "ok" }] },
      ],
    ]);
    expect(monitor(partial, expected, t0).body).toBe(
      "indexer-monitor-unavailable event-gap=no-report:starknet/mainnet",
    );
  });

  it("flags a head-lag report that leaves out an expected chain", () => {
    const state = feed([
      [t0, { kind: "head-lag", ok: true, chains: ["eth"], lagging: [] }],
      [t0, gaps("ok")],
    ]);
    expect(monitor(state, expected, t0).body).toBe(
      "indexer-monitor-unavailable head-lag=unconfigured:base",
    );
  });

  it("refuses malformed reports", () => {
    for (const body of [
      null,
      "x",
      { kind: "head-lag", ok: true, chains: ["eth"], lagging: ["base"] },
      { kind: "head-lag", ok: true, chains: ["ETH OR 1=1"], lagging: [] },
      { kind: "head-lag", ok: false, error: "anything" },
      { kind: "event-gaps", chains: [{ chain: "mainnet", outcome: "fine" }] },
      {
        kind: "event-gaps",
        chains: Array.from({ length: 65 }, () => ({
          chain: "a",
          outcome: "ok",
        })),
      },
      { kind: "other" },
    ])
      expect(parseReport(body, t0)).toBeNull();
  });

  it("expects all 15 production chains, as the app spec configures them", async () => {
    type Spec = {
      workers: {
        name: string;
        envs?: { key: string; value?: string }[];
      }[];
    };
    const spec = Bun.YAML.parse(
      await Bun.file(`${import.meta.dir}/../.do/app.yaml`).text(),
    ) as Spec;
    const monitorWorker = spec.workers.find(
      (w) => w.name === "indexer-monitor",
    );
    const headLagChains = monitorWorker?.envs?.find(
      (e) => e.key === "HEAD_LAG_CHAINS",
    )?.value;
    const configured = [...parseChains(headLagChains ?? "").values()];
    expect(configured.map((c) => c.name).sort()).toEqual(
      [...EXPECTED.headChains].sort(),
    );
    expect(configured.every((c) => c.thresholdSeconds === undefined)).toBe(
      true,
    );
    const indexers = spec.workers.filter((w) => w.name.endsWith("-mainnet"));
    expect(indexers).toHaveLength(15);
    expect(EXPECTED.headChains).toHaveLength(15);
    expect(new Set(EXPECTED.gapChains).size).toBe(15);
    expect(EXPECTED.gapChains).toContain("starknet/mainnet");
  });

  it("compares digests in full", () => {
    expect(sameDigest(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(
      true,
    );
    expect(sameDigest(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(
      false,
    );
    expect(sameDigest(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("production monitor reports", () => {
  const config = {
    chains: parseChains("1=eth,8453=base"),
    defaultThresholdSeconds: 300,
    sustainChecks: 2,
    realertMs: Infinity,
  };
  const rows = (baseLag: number): CursorRow[] => [
    {
      chainId: "1",
      headBlockNumber: "1",
      lagSeconds: 12,
      updatedSecondsAgo: 1,
    },
    {
      chainId: "8453",
      headBlockNumber: "1",
      lagSeconds: baseLag,
      updatedSecondsAgo: 1,
    },
  ];

  it("reports lag only after two consecutive observations over 300 s", () => {
    let state = {};
    const reports = [400, 400, 400, 20].map((lag, i) => {
      const result = evaluate(
        rows(lag),
        config,
        state,
        new Date(t0 + i * minute),
      );
      state = result.next;
      return headLagReport(result.results, config.sustainChecks);
    });
    expect(reports.map((r) => (r.ok ? r.lagging : null))).toEqual([
      [],
      ["base"],
      ["base"],
      [],
    ]);
    // The receiver accepts what the monitor sends.
    expect(parseReport(reports[1], t0)).not.toBeNull();
  });

  it("counts a configured chain with no cursor row as lagging", () => {
    let state = {};
    let report;
    for (let i = 0; i < 2; i++) {
      const result = evaluate(
        rows(1).slice(0, 1),
        config,
        state,
        new Date(t0 + i * minute),
      );
      state = result.next;
      report = headLagReport(result.results, 2);
    }
    expect(report).toEqual({
      kind: "head-lag",
      ok: true,
      chains: ["eth", "base"],
      lagging: ["base"],
    });
  });

  it("maps audit results to verdicts without leaking detail", () => {
    const summary = {
      kind: "summary" as const,
      chainId: "1",
      from: 1,
      to: 2,
      missing: 0,
      hash: 0,
      missingEvents: 0,
    };
    const results: Result[] = [
      { network: "mainnet", ok: true, summary },
      {
        network: "base-mainnet",
        ok: false,
        gap: true,
        summary: { ...summary, missing: 1 },
        findings: [{ block: 2 }],
      },
      {
        network: "starknet/mainnet",
        ok: false,
        gap: false,
        error: "https://key@rpc timeout",
      },
    ];
    const report = gapReport(results);
    expect(report).toEqual({
      kind: "event-gaps",
      chains: [
        { chain: "mainnet", outcome: "ok" },
        { chain: "base-mainnet", outcome: "gap" },
        { chain: "starknet/mainnet", outcome: "check_failed" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("key");
    expect(parseReport(report, t0)).not.toBeNull();
  });

  it("parses the gap chain list as the workstation monitor did", () => {
    expect(
      parseGapChains("mainnet=https://a,starknet/mainnet=https://b|5000"),
    ).toEqual([
      {
        label: "mainnet",
        network: "mainnet",
        networkType: "evm",
        rpcUrl: "https://a",
        maxRange: undefined,
      },
      {
        label: "starknet/mainnet",
        network: "mainnet",
        networkType: "starknet",
        rpcUrl: "https://b",
        maxRange: "5000",
      },
    ]);
    expect(() => parseGapChains("https://secret")).toThrow(
      "entry 1 must be network=rpcUrl",
    );
  });

  it("starts cycles on a fixed cadence without overlap", () => {
    expect(delayUntilNext(0, 10_000, 60_000)).toBe(50_000);
    expect(delayUntilNext(0, 70_000, 60_000)).toBe(0);
  });
});
