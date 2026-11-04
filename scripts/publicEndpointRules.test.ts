import { describe as group, expect, it } from "bun:test";
import {
  blockTimeOf,
  describe,
  endpointPath,
  evaluate,
  headline,
  markAlerted,
  parseChains,
  toProbe,
  type EndpointConfig,
  type EndpointState,
  type Finding,
  type Probe,
  type Service,
} from "./publicEndpointRules";

const config: EndpointConfig = {
  chains: parseChains("1=eth,23448594291968334=starknet"),
  sustainChecks: 2,
  realertMs: 60 * 60_000,
  quoterLagSeconds: 300,
};

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 4, 12, minutes));
const head = Date.UTC(2026, 10, 4, 12, 0) / 1000;

const up = (service: Service, chainId: string, blockTime = head): Probe => ({
  service,
  chainId,
  ok: true,
  status: 200,
  ms: 90,
  blockTime,
});
const down = (service: Service, chainId: string, status = 503): Probe => ({
  service,
  chainId,
  ok: false,
  status,
  ms: 40,
  error: `HTTP ${status}`,
});

const healthy = [
  up("api", "1"),
  up("quoter", "1"),
  up("api", "23448594291968334"),
  up("quoter", "23448594291968334"),
];
const starknetQuoterDown = [
  up("api", "1"),
  up("quoter", "1"),
  up("api", "23448594291968334"),
  down("quoter", "23448594291968334"),
];
const starknetQuoterBehind = (seconds: number) => [
  up("api", "1"),
  up("quoter", "1"),
  up("api", "23448594291968334"),
  up("quoter", "23448594291968334", head - seconds),
];

const label = (f: Finding) =>
  f.kind === "endpoint_down" ? `${f.service}:${f.name}` : `behind:${f.name}`;

/** Runs one check a minute, marking findings as delivered like the monitor does. */
function replay(
  checks: { probes: Probe[]; controlOk?: boolean | null }[],
  start: EndpointState = {},
) {
  let state = start;
  return checks.map(({ probes, controlOk = null }, minute) => {
    const now = at(minute);
    const { findings, next } = evaluate(probes, controlOk, config, state, now);
    state = markAlerted(next, findings, now);
    return findings.map(label);
  });
}
const runs = (...lists: Probe[][]) => lists.map((probes) => ({ probes }));

group("public endpoint rules", () => {
  it("parses the chain list", () => {
    expect(config.chains).toEqual([
      { chainId: "1", name: "eth" },
      { chainId: "23448594291968334", name: "starknet" },
    ]);
    expect(() => parseChains("eth")).toThrow(/chainId=name/);
  });

  it("requests the API's latest block and each quoter's health route", () => {
    expect(endpointPath("api", "1")).toBe("/blocks/1/latest");
    expect(endpointPath("quoter", "23448594291968334")).toBe(
      "/23448594291968334/health",
    );
  });

  it("reads block times from both bodies as they are served", () => {
    expect(
      blockTimeOf(
        "api",
        '{"number":24162335,"timestamp":"2026-11-04T12:00:00.000Z"}',
      ),
    ).toBe(head);
    expect(
      blockTimeOf(
        "quoter",
        `{"block_number":1,"block_hash":"0x1","latest_block_timestamp":${head},"last_event_id":"1","base_fee_per_gas":"1"}`,
      ),
    ).toBe(head);
  });

  it("fails a response that is not a block, even with status 200", () => {
    expect(toProbe("api", "1", 200, "<html>oops</html>", 5)).toMatchObject({
      ok: false,
      error: "response has no block time",
    });
    expect(
      toProbe("api", "1", 200, '{"status":500,"error":"Internal"}', 5),
    ).toMatchObject({ ok: false });
    expect(
      toProbe("quoter", "1", 200, '{"latest_block_timestamp":0}', 5),
    ).toMatchObject({ ok: false });
    expect(toProbe("quoter", "1", 302, "", 5)).toMatchObject({
      ok: false,
      status: 302,
      error: "HTTP 302",
    });
    expect(
      toProbe("quoter", "1", 200, `{"latest_block_timestamp":${head}}`, 5),
    ).toMatchObject({ ok: true, blockTime: head });
  });

  it("stays quiet while everything answers", () => {
    expect(replay(runs(healthy, healthy, healthy))).toEqual([[], [], []]);
  });

  it("does not alert on a single failed check", () => {
    expect(replay(runs(healthy, starknetQuoterDown, healthy))).toEqual([
      [],
      [],
      [],
    ]);
  });

  it("alerts on the second failure in a row, once per hour, and afresh after recovery", () => {
    const raised = replay(
      runs(
        healthy,
        ...Array<Probe[]>(62).fill(starknetQuoterDown),
        healthy,
        starknetQuoterDown,
        starknetQuoterDown,
      ),
    );
    const minutes = raised.flatMap((r, minute) => (r.length ? [minute] : []));
    expect(minutes).toEqual([2, 62, 65]);
    expect(raised[2]).toEqual(["quoter:starknet"]);
  });

  it("reports every failing endpoint of an outage in one run", () => {
    const allDown = healthy.map((p) => down(p.service, p.chainId, 502));
    const raised = replay(
      runs(allDown, allDown).map((r) => ({ ...r, controlOk: true })),
    );
    expect(raised[1]).toEqual([
      "api:eth",
      "quoter:eth",
      "api:starknet",
      "quoter:starknet",
    ]);
  });

  it("raises nothing while this host is offline, and keeps the streaks", () => {
    const offline = healthy.map((p): Probe => ({
      service: p.service,
      chainId: p.chainId,
      ok: false,
      status: null,
      ms: 3,
      error: "ConnectionRefused: Unable to connect",
    }));
    const first = evaluate(starknetQuoterDown, true, config, {}, at(0));
    expect(first.findings).toEqual([]);
    const blind = evaluate(offline, false, config, first.next, at(1));
    expect(blind).toMatchObject({ offline: true, findings: [] });
    expect(blind.next).toEqual(first.next);
    const back = evaluate(starknetQuoterDown, true, config, blind.next, at(2));
    expect(back.findings.map(label)).toEqual(["quoter:starknet"]);
  });

  it("treats a failing control as offline only when nothing answered", () => {
    const { offline, findings } = evaluate(
      starknetQuoterDown,
      false,
      config,
      { down: { "quoter:23448594291968334": { count: 1 } } },
      at(0),
    );
    expect(offline).toBe(false);
    expect(findings.map(label)).toEqual(["quoter:starknet"]);
  });

  it("alerts when a quoter stops following the indexed head", () => {
    expect(
      replay(
        runs(
          starknetQuoterBehind(30),
          starknetQuoterBehind(400),
          starknetQuoterBehind(460),
          starknetQuoterBehind(520),
          starknetQuoterBehind(10),
        ),
      ),
    ).toEqual([[], [], ["behind:starknet"], [], []]);
  });

  it("does not compare a quoter with an API that did not answer", () => {
    const apiDown = [
      up("api", "1"),
      up("quoter", "1"),
      down("api", "23448594291968334"),
      up("quoter", "23448594291968334", head - 900),
    ];
    const first = evaluate(starknetQuoterBehind(900), true, config, {}, at(0));
    const gap = evaluate(apiDown, true, config, first.next, at(1));
    expect(gap.findings.map(label)).toEqual([]);
    expect(gap.results.find((r) => r.name === "starknet")).toEqual({
      chainId: "23448594291968334",
      name: "starknet",
      quoterLagSeconds: null,
    });
    // The streak carries over the gap rather than restarting.
    const after = evaluate(
      starknetQuoterBehind(900),
      true,
      config,
      gap.next,
      at(2),
    );
    expect(after.findings.map(label)).toEqual(["behind:starknet"]);
  });

  it("does not mark an undelivered alert, so the next run raises it again", () => {
    const first = evaluate(
      starknetQuoterDown,
      true,
      config,
      { down: { "quoter:23448594291968334": { count: 1 } } },
      at(0),
    );
    expect(first.findings).toHaveLength(1);
    const second = evaluate(
      starknetQuoterDown,
      true,
      config,
      first.next,
      at(1),
    );
    expect(second.findings).toHaveLength(1);
  });

  it("ignores a synthetic finding when marking alerts", () => {
    const state: EndpointState = { down: { "api:1": { count: 3 } } };
    const synthetic: Finding = {
      kind: "endpoint_down",
      service: "api",
      chainId: "0",
      name: "test",
      failures: 0,
      status: null,
      error: "synthetic test alert",
    };
    expect(markAlerted(state, [synthetic], at(0)).down).toEqual(state.down);
  });

  it("describes findings for the alert summary", () => {
    const [outage] = evaluate(
      starknetQuoterDown,
      true,
      config,
      { down: { "quoter:23448594291968334": { count: 1 } } },
      at(0),
    ).findings;
    expect(describe(outage)).toBe(
      "quoter starknet (23448594291968334) failing 2 checks in a row: HTTP 503",
    );
    expect(headline([outage])).toBe("Public endpoint down");
    const [behind] = evaluate(
      starknetQuoterBehind(412),
      true,
      config,
      { behind: { "23448594291968334": { count: 1 } } },
      at(0),
    ).findings;
    expect(describe(behind)).toBe(
      "quoter starknet (23448594291968334) is 412s behind the API's latest block, threshold 300s, 2 checks in a row",
    );
    expect(headline([behind])).toBe("Quoter behind the indexed head");
  });
});
