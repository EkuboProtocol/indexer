import { describe, expect, it } from "bun:test";
import type { Address, Hex } from "viem";
import { numberToHex } from "viem";
import type { ChainHead, TickSignal } from "../_shared/blockStream";
import { createLogStream, type RawLog, type RpcLike, type StreamMessage } from "./logStream";
import { StickyRpc, WrongChainIdError } from "./stickyRpc";

const CORE = "0x00000000000014aA86C5d3c41765bb24e11bd701" as Address;
const CHAIN_ID = 4663n;
const hashOf = (n: number) => numberToHex(BigInt(n) + (1n << 200n), { size: 32 });

/**
 * A provider over one shared chain: block `n` is `n` seconds after `genesisSec`,
 * the head follows the wall clock, and every 5th block carries one event. A
 * provider can refuse `eth_getLogs`, freeze its head, or stop answering.
 */
function provider(label: string, calls: string[], genesisSec: number) {
  const state = {
    refuseLogs: false,
    frozenAt: null as number | null,
    down: false,
    chainId: CHAIN_ID,
  };
  const headNumber = () => state.frozenAt ?? Math.floor(Date.now() / 1000) - genesisSec;
  const block = (n: number) => ({
    number: numberToHex(n), hash: hashOf(n), timestamp: numberToHex(genesisSec + n),
  });
  const blockByNumber = (tag: string) => {
    const head = headNumber();
    if (tag === "latest") return block(head);
    if (tag === "finalized") return block(Math.max(0, head - 20));
    const n = Number(BigInt(tag));
    return n <= head ? block(n) : null;
  };
  const getLogs = ({ fromBlock, toBlock }: { fromBlock: Hex; toBlock: Hex }) => {
    if (state.refuseLogs) throw new Error("Invalid parameters were provided to the RPC method");
    const logs: RawLog[] = [];
    for (let n = Number(BigInt(fromBlock)); n <= Number(BigInt(toBlock)); n++) {
      if (n % 5 !== 0 || n > headNumber()) continue;
      logs.push({
        address: CORE, topics: [hashOf(1)], data: "0x", blockHash: hashOf(n),
        blockNumber: numberToHex(n), blockTimestamp: numberToHex(genesisSec + n),
        transactionHash: hashOf(n + 7), transactionIndex: "0x0", logIndex: "0x0",
      });
    }
    return logs;
  };
  const rpc: RpcLike = {
    request: (async ({ method, params }: { method: string; params: unknown[] }) => {
      calls.push(`${label}:${method}`);
      if (state.down) throw new Error(`HTTP request failed. URL: http://${label}/v2/SECRETKEY`);
      if (method === "eth_chainId") return numberToHex(state.chainId);
      if (method === "eth_getBlockByNumber") return blockByNumber(params[0] as string);
      if (method === "eth_getLogs") return getLogs(params[0] as { fromBlock: Hex; toBlock: Hex });
      throw new Error(`unexpected ${method}`);
    }) as RpcLike["request"],
  };
  return { rpc, state, headNumber };
}

function setup(opts: { failbackMs?: number; staleHeadMs?: number } = {}) {
  const calls: string[] = [];
  const warnings: { message: string; detail: Record<string, unknown> }[] = [];
  const genesisSec = Math.floor(Date.now() / 1000) - 1_000;
  const a = provider("A", calls, genesisSec);
  const b = provider("B", calls, genesisSec);
  const sticky = new StickyRpc(
    [
      { label: "http://A", rpc: a.rpc, suspectLogCount: 10_000 },
      { label: "http://B", rpc: b.rpc, suspectLogCount: 20_000 },
    ],
    {
      chainId: CHAIN_ID,
      staleHeadMs: opts.staleHeadMs ?? 120_000,
      failbackMs: opts.failbackMs ?? 15 * 60_000,
      probeIntervalMs: 30_000,
      onWarning: (message, detail) => warnings.push({ message, detail }),
    },
  );
  // Every loop turn starts with `beforeTick`. Mark where it starts (its own
  // probes may go anywhere) and where the turn's reads begin, so requests can
  // be grouped by the turn that made them.
  const beforeTick = sticky.beforeTick.bind(sticky);
  sticky.beforeTick = async (signal: TickSignal) => {
    calls.push("--probe--");
    const switched = await beforeTick(signal);
    calls.push("--turn--");
    return switched;
  };
  return { calls, warnings, a, b, sticky, genesisSec };
}

function stream(sticky: StickyRpc, cursor: number) {
  return createLogStream({
    rpc: sticky,
    endpoints: sticky,
    filters: [{ id: 1, address: CORE, topics: [], strict: false }],
    startingCursor: { orderKey: BigInt(cursor) },
    options: {
      pollIntervalMs: 1, maxPollIntervalMs: 2, maxLogRangeBlocks: 100,
      heartbeatIntervalMs: 1_000_000, providerOutageBudgetMs: 60_000,
      suspectLogCount: () => sticky.current.suspectLogCount,
    },
  });
}

/** The next `n` data messages, leaving the stream open (a `for await` break would close it). */
async function take(s: AsyncGenerator<StreamMessage>, n: number): Promise<StreamMessage[]> {
  const out: StreamMessage[] = [];
  while (out.length < n) {
    const { value, done } = await s.next();
    if (done) break;
    if (value._tag === "data") out.push(value);
  }
  return out;
}

/** Each loop turn's reads (not `beforeTick`'s probes), by the endpoint that served them. */
function endpointsPerTurn(calls: string[]): Set<string>[] {
  const turns: Set<string>[] = [];
  let inTurn = false;
  for (const call of calls) {
    if (call === "--turn--") {
      turns.push(new Set());
      inTurn = true;
    } else if (call === "--probe--") {
      inTurn = false;
    } else if (inTurn) {
      turns.at(-1)!.add(call.split(":")[0]!);
    }
  }
  return turns;
}

describe("StickyRpc in the block stream", () => {
  it("fails over on a refused range and never mixes providers within a loop turn", async () => {
    const { calls, warnings, a, sticky } = setup();
    await sticky.start();
    // Far enough behind that catching up takes several range reads, so a read
    // after the refusal starts is made rather than served from the first one.
    const s = stream(sticky, a.headNumber() - 600);
    await take(s, 3);
    a.state.refuseLogs = true;
    const after = await take(s, 60);
    await s.return(undefined);

    expect(sticky.current.label).toBe("http://B");
    expect(warnings.find((w) => w.message === "switched RPC endpoint")?.detail)
      .toEqual({ from: "http://A", to: "http://B", reason: "read failed" });
    expect(after.length).toBe(60);
    // Plan, snapshot, reconciliation and finality within a turn: one endpoint.
    const turns = endpointsPerTurn(calls);
    expect(turns.length).toBeGreaterThan(5);
    for (const turn of turns) expect(turn.size).toBeLessThanOrEqual(1);
    expect(turns.some((t) => t.has("A"))).toBe(true);
    expect(turns.some((t) => t.has("B"))).toBe(true);
  });

  it("uses the current endpoint's result cap", async () => {
    const { a, sticky } = setup();
    await sticky.start();
    expect(sticky.current.suspectLogCount).toBe(10_000);
    a.state.refuseLogs = true;
    const s = stream(sticky, a.headNumber() - 50);
    await take(s, 1);
    await s.return(undefined);
    expect(sticky.current.suspectLogCount).toBe(20_000);
  });
});

describe("StickyRpc switching", () => {
  const signal = (over: Partial<TickSignal>): TickSignal => ({
    cursorBlock: 0, lastReadFailed: false, lastHead: null, ...over,
  });
  const headAt = (number: number, genesisSec: number): ChainHead => ({
    number, hash: hashOf(number), timestamp: new Date((genesisSec + number) * 1000), baseFeePerGas: null,
  });

  it("leaves a silently frozen head for a provider that is ahead of it", async () => {
    const { a, b, sticky, genesisSec, warnings } = setup();
    await sticky.start();
    const frozen = b.headNumber() - 300;
    a.state.frozenAt = frozen;
    expect(await sticky.beforeTick(signal({ cursorBlock: frozen, lastHead: headAt(frozen, genesisSec) }))).toBe(true);
    expect(sticky.current.label).toBe("http://B");
    expect(warnings.at(-1)?.detail.reason).toBe("stale head");
  });

  it("stays put through a chain halt instead of flipping every turn", async () => {
    const { a, b, sticky, genesisSec, warnings } = setup();
    await sticky.start();
    const halted = a.headNumber() - 300;
    a.state.frozenAt = halted;
    b.state.frozenAt = halted;
    const tick = signal({ cursorBlock: halted, lastHead: headAt(halted, genesisSec) });
    expect(await sticky.beforeTick(tick)).toBe(false);
    expect(warnings.at(-1)).toMatchObject({ message: "RPC endpoint not healthier; staying", detail: { reason: "stale head" } });
    // Not re-probed within the probe interval.
    const probes = warnings.length;
    expect(await sticky.beforeTick(tick)).toBe(false);
    expect(warnings.length).toBe(probes);
    expect(sticky.current.label).toBe("http://A");
  });

  it("does not switch to a provider behind the cursor", async () => {
    const { a, b, sticky } = setup();
    await sticky.start();
    b.state.frozenAt = a.headNumber() - 10;
    expect(await sticky.beforeTick(signal({ cursorBlock: a.headNumber(), lastReadFailed: true }))).toBe(false);
  });

  it("fails back only once the primary passes its probe", async () => {
    const { a, sticky } = setup({ failbackMs: 1 });
    await sticky.start();
    a.state.down = true;
    expect(await sticky.beforeTick(signal({ cursorBlock: 10, lastReadFailed: true }))).toBe(true);
    await Bun.sleep(5);
    // Still down: no failback, and B is kept.
    expect(await sticky.beforeTick(signal({ cursorBlock: 10 }))).toBe(false);
    expect(sticky.current.label).toBe("http://B");
  });

  it("fails back to a primary that recovered", async () => {
    const { a, sticky, warnings } = setup({ failbackMs: 1 });
    await sticky.start();
    a.state.refuseLogs = true;
    expect(await sticky.beforeTick(signal({ cursorBlock: 10, lastReadFailed: true }))).toBe(true);
    await Bun.sleep(5);
    expect(await sticky.beforeTick(signal({ cursorBlock: 10 }))).toBe(true);
    expect(sticky.current.label).toBe("http://A");
    expect(warnings.at(-1)?.detail.reason).toBe("failback");
  });
});

describe("StickyRpc startup", () => {
  it("starts on the secondary when the primary does not answer", async () => {
    const { a, sticky } = setup();
    a.state.down = true;
    await sticky.start();
    expect(sticky.current.label).toBe("http://B");
  });

  it("does not let an unreachable secondary stop a healthy primary", async () => {
    const { b, sticky } = setup();
    b.state.down = true;
    await sticky.start();
    expect(sticky.current.label).toBe("http://A");
  });

  it("is fatal when any endpoint names another chain, including at first use", async () => {
    const wrongPrimary = setup();
    wrongPrimary.a.state.chainId = 1n;
    await expect(wrongPrimary.sticky.start()).rejects.toBeInstanceOf(WrongChainIdError);

    const wrongSecondary = setup();
    wrongSecondary.b.state.chainId = 1n;
    await wrongSecondary.sticky.start();
    await expect(wrongSecondary.sticky.beforeTick({ cursorBlock: 0, lastReadFailed: true, lastHead: null }))
      .rejects.toBeInstanceOf(WrongChainIdError);
  });

  it("backs off until an endpoint answers, within the budget", async () => {
    const { a, b, sticky } = setup();
    a.state.down = true;
    b.state.down = true;
    setTimeout(() => { b.state.down = false; }, 20);
    await sticky.startWithin(60_000, 5, 10);
    expect(sticky.current.label).toBe("http://B");

    const dead = setup();
    dead.a.state.down = true;
    dead.b.state.down = true;
    await expect(dead.sticky.startWithin(10, 2, 4)).rejects.toThrow(/HTTP request failed/);
  });

  it("never switches with a single endpoint", async () => {
    const calls: string[] = [];
    const only = provider("A", calls, Math.floor(Date.now() / 1000) - 1_000);
    const sticky = new StickyRpc([{ label: "http://A", rpc: only.rpc, suspectLogCount: 10_000 }], {
      chainId: CHAIN_ID, staleHeadMs: 1, failbackMs: 1, probeIntervalMs: 1,
    });
    await sticky.start();
    calls.length = 0;
    expect(await sticky.beforeTick({ cursorBlock: 0, lastReadFailed: true, lastHead: null })).toBe(false);
    expect(calls).toEqual([]);
  });
});
