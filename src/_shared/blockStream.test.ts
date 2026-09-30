import { describe, expect, it } from "bun:test";
import { StaleSnapshotError } from "./blockSnapshot";
import {
  createBlockStream,
  MAX_STALE_SNAPSHOTS,
  type ChainAdapter,
  type ChainHead,
  type StreamBlock,
  type StreamMessage,
} from "./blockStream";

const head = (number: number, hash = `0x${number.toString(16)}`): ChainHead => ({
  number,
  hash: hash as `0x${string}`,
  timestamp: new Date(number * 1000),
  baseFeePerGas: null,
});

const block = (number: number, hash: string): StreamBlock<string> => ({
  header: {
    blockNumber: BigInt(number),
    blockHash: hash as `0x${string}`,
    timestamp: new Date(number * 1000),
    baseFeePerGas: null,
  },
  logs: [hash],
});

const options = {
  pollIntervalMs: 1,
  maxPollIntervalMs: 1,
  finalizedRefreshIntervalMs: 1,
  maxLogRangeBlocks: 100,
  heartbeatIntervalMs: 1_000_000,
};

it("reconciles a reorg before accepting finality and preserves pending finality through rollback", async () => {
  let tick = 0;
  const ranges: number[][] = [];
  const end = new Error("end fixture");
  const adapter: ChainAdapter<string> = {
    label: "fixture",
    async fetchBlock(n) {
      if (n === 90) return head(90);
      if (n === 100) return head(n, tick <= 1 ? "0xaaa" : "0xbbb");
      return head(n, tick <= 1 ? "0xa101" : `0xb${n}`);
    },
    async fetchHead() {
      if (++tick > 4) throw end;
      return head(100 + tick, tick === 1 ? "0xa101" : `0xb${100 + tick}`);
    },
    async fetchFinalized() {
      if (tick === 0) return head(90);
      // The refresh after rollback may fail; the earlier observation survives.
      if (tick > 1) throw new Error("temporary finality outage");
      return head(101, "0xb101");
    },
    async readRange(from, to) {
      ranges.push([from, to]);
      // Ensure the next poll is due to refresh finality (four poll intervals).
      await Bun.sleep(10);
      return from <= 100 && to >= 100
        ? [block(100, tick === 1 ? "0xaaa" : "0xbbb")]
        : [];
    },
    async completeFresh() {},
  };
  const messages: StreamMessage<string>[] = [];
  try {
    // A failed head read is backed off rather than thrown until the outage
    // budget runs out, so a tiny budget is what ends the fixture.
    for await (const message of createBlockStream({
      adapter, startingCursor: { orderKey: 99n },
      options: { ...options, providerOutageBudgetMs: 1 },
    })) messages.push(message);
  } catch (error) {
    if (error !== end) throw error;
  }

  const rollback = messages.findIndex(m => m._tag === "invalidate");
  const replacement = messages.findIndex(m =>
    m._tag === "data" && m.data.data[0]?.logs[0] === "0xbbb");
  const finalized = messages.findIndex(m =>
    m._tag === "finalize" && m.finalize.cursor.orderKey === 101n);
  expect(ranges[1]![0]).toBeLessThanOrEqual(100);
  expect(rollback).toBeGreaterThanOrEqual(0);
  expect(replacement).toBeGreaterThan(rollback);
  expect(finalized).toBeGreaterThan(replacement);
});

for (const failure of ["throw", "null"] as const) {
  it(`does not read or advance when startup cursor verification returns ${failure}`, async () => {
    let reads = 0;
    let unavailable = true;
    const adapter: ChainAdapter<string> = {
      label: "fixture",
      async fetchBlock() {
        if (!unavailable) return head(100, "0xbbb");
        if (failure === "throw") throw new Error("temporary RPC outage");
        return null;
      },
      async fetchHead() { reads++; return head(101); },
      async fetchFinalized() { reads++; return head(90); },
      async readRange() { reads++; return [block(100, "0xbbb")]; },
      async completeFresh() {},
    };
    // Startup reads are retried like any other until the outage budget runs
    // out, and nothing is read past them in the meantime.
    const args = {
      adapter, startingCursor: { orderKey: 100n, uniqueKey: "0xaaa" },
      options: { ...options, providerOutageBudgetMs: 5 },
    };
    const stream = createBlockStream(args);
    await expect(stream.next()).rejects.toThrow();
    expect(reads).toBe(0);

    // A subsequent runtime restart verifies the same durable cursor and rolls
    // back before it emits any replacement data or finality.
    unavailable = false;
    const retry = createBlockStream(args);
    expect((await retry.next()).value?._tag).toBe("invalidate");
    await retry.return(undefined);
  });
}

it("retries startup cursor verification through an outage instead of exiting", async () => {
  let fetches = 0;
  const warnings: string[] = [];
  const adapter: ChainAdapter<string> = {
    label: "fixture",
    async fetchBlock(n) {
      if (++fetches <= 3) throw new Error("HTTP request failed. Status: 503");
      return head(n, n === 100 ? "0xbbb" : `0x${n.toString(16)}`);
    },
    async fetchHead() { return head(101); },
    async fetchFinalized() { return head(90); },
    async readRange() { return [block(100, "0xbbb")]; },
    async completeFresh() {},
  };
  const stream = createBlockStream({
    adapter, startingCursor: { orderKey: 100n, uniqueKey: "0xbbb" },
    options: { ...options, onWarning: message => warnings.push(message) },
  });
  const first = await stream.next();
  await stream.return(undefined);
  expect(first.value?._tag).toBe("data");
  expect(warnings).toEqual(Array(3).fill("provider read failed; backing off"));
});

describe("a stale snapshot", () => {
  const run = async (staleReads: number, failure: () => Error = () =>
    new StaleSnapshotError("end block not found; retry the snapshot")) => {
    let heads = 0;
    let reads = 0;
    const warnings: string[] = [];
    const adapter: ChainAdapter<string> = {
      label: "fixture",
      async fetchBlock(n) { return head(n); },
      async fetchHead() { heads++; return head(100 + heads); },
      async fetchFinalized() { return head(90); },
      async readRange(_from, to) {
        if (++reads <= staleReads) throw failure();
        return [block(to, head(to).hash)];
      },
      async completeFresh() {},
    };
    const stream = createBlockStream({
      adapter, startingCursor: { orderKey: 99n },
      options: { ...options, onWarning: message => warnings.push(message) },
    });
    try {
      for await (const message of stream) {
        if (message._tag === "data") return { message, heads, warnings };
      }
      throw new Error("stream ended");
    } finally {
      await stream.return(undefined);
    }
  };

  it("is re-read from a fresh head instead of exiting", async () => {
    const { message, heads, warnings } = await run(2);
    expect(heads).toBe(3);
    expect(warnings).toEqual(["retrying a stale snapshot", "retrying a stale snapshot"]);
    if (message._tag !== "data") throw new Error("unreachable");
    expect(message.data.endCursor?.orderKey).toBe(103n);
  });

  it("still exits once the streak is too long to be the tip", async () => {
    await expect(run(MAX_STALE_SNAPSHOTS + 1)).rejects.toBeInstanceOf(StaleSnapshotError);
  });

});

// EKU-502: during the Alchemy US-East incident of 2026-09-30 the provider
// advertised a head and then refused eth_getLogs up to it for sixteen minutes.
// Each refusal exited the worker, and restart.sh brought it straight back to
// ask for the same range: 89 to 315 restarts per chain.
describe("a provider that refuses reads at the head", () => {
  const refusal = "Invalid parameters were provided to the RPC method";
  const run = async (opts: {
    failingReads?: number;
    failingHeads?: number;
    budgetMs?: number;
  }) => {
    let heads = 0;
    let reads = 0;
    const warnings: { message: string; detail: Record<string, unknown> }[] = [];
    const adapter: ChainAdapter<string> = {
      label: "fixture",
      async fetchBlock(n) { return head(n); },
      async fetchHead() {
        if (++heads <= (opts.failingHeads ?? 0)) throw new Error("HTTP request failed. Status: 503");
        return head(100 + heads);
      },
      async fetchFinalized() { return head(90); },
      async readRange(_from, to) {
        if (++reads <= (opts.failingReads ?? 0)) throw new Error(`eth_getLogs failed. Cause: ${refusal}`);
        return [block(to, head(to).hash)];
      },
      async completeFresh() {},
    };
    const stream = createBlockStream({
      adapter, startingCursor: { orderKey: 99n },
      options: {
        ...options,
        pollIntervalMs: 1,
        maxPollIntervalMs: 4,
        providerOutageBudgetMs: opts.budgetMs ?? 60_000,
        onWarning: (message, detail) => warnings.push({ message, detail }),
      },
    });
    try {
      for await (const message of stream) {
        if (message._tag === "data") return { message, heads, reads, warnings };
      }
      throw new Error("stream ended");
    } finally {
      await stream.return(undefined);
    }
  };

  it("backs off and re-reads a refused range instead of exiting", async () => {
    const { message, reads, warnings } = await run({ failingReads: 5 });
    expect(reads).toBe(6);
    expect(warnings.map(w => w.message)).toEqual(Array(5).fill("provider read failed; backing off"));
    // Doubling from the poll floor, held at the configured ceiling.
    expect(warnings.map(w => w.detail.retryInMs)).toEqual([1, 2, 4, 4, 4]);
    expect(warnings[0]!.detail).toMatchObject({ read: "range", to: 101, head: 101, cursor: 99 });
    expect(String(warnings[0]!.detail.error)).toContain(refusal);
    if (message._tag !== "data") throw new Error("unreachable");
    expect(message.data.endCursor?.orderKey).toBe(106n);
  });

  it("backs off through an unreadable head", async () => {
    const { message, warnings } = await run({ failingHeads: 3 });
    expect(warnings.map(w => w.detail.read)).toEqual(["head", "head", "head"]);
    if (message._tag !== "data") throw new Error("unreachable");
    expect(message.data.endCursor?.orderKey).toBe(104n);
  });

  it("still exits with the provider's error once the outage outlasts the budget", async () => {
    await expect(run({ failingReads: Number.MAX_SAFE_INTEGER, budgetMs: 20 }))
      .rejects.toThrow(refusal);
  });
});

/**
 * The runtime's effect on the store, reduced to what the gap question needs:
 * a data message replaces everything from its block up and records the block
 * only if it carried events; an invalidate deletes everything above its cursor.
 */
function createStore(startingCursor: number) {
  const blocks = new Map<number, string>();
  let cursor: { orderKey: bigint; uniqueKey?: string } = { orderKey: BigInt(startingCursor) };
  return {
    blocks,
    get cursor() { return cursor; },
    apply(message: StreamMessage<string>) {
      if (message._tag === "invalidate") {
        for (const n of [...blocks.keys()]) if (n > Number(message.invalidate.cursor.orderKey)) blocks.delete(n);
        cursor = message.invalidate.cursor;
      } else if (message._tag === "data") {
        const [streamBlock] = message.data.data;
        const n = Number(streamBlock!.header.blockNumber);
        for (const k of [...blocks.keys()]) if (k >= n) blocks.delete(k);
        if (streamBlock!.logs.length > 0) blocks.set(n, streamBlock!.header.blockHash);
        cursor = message.data.endCursor;
      }
    },
    loadStoredBlocks: async (from: number, to: number) => ({
      from: startingCursor + 1,
      hashes: new Map([...blocks].filter(([n]) => n >= from && n <= to)),
    }),
  };
}

const eventBearing = (n: number) => n % 3 !== 0;

/** A chain whose hashes never change, so every rollback below is a provider fault being repaired. */
function faultyChain(opts: { tip: number; lagging: () => number; regress: () => number }) {
  let tip = opts.tip;
  const adapter: ChainAdapter<string> = {
    label: "fixture",
    async fetchHead() { return head(Math.max(1, tip - opts.regress())); },
    async fetchBlock(n) { return n <= tip ? head(n) : null; },
    async fetchFinalized() { return null; },
    async readRange(from, to) {
      // A log index lagging its head: the newest blocks read as empty.
      const indexedTo = to - opts.lagging();
      const blocks: StreamBlock<string>[] = [];
      for (let n = from; n <= indexedTo; n++) if (eventBearing(n)) blocks.push(block(n, head(n).hash));
      return blocks;
    },
    async completeFresh() {},
  };
  return { adapter, advance() { tip++; }, get tip() { return tip; } };
}

async function runUntil(
  stream: AsyncGenerator<StreamMessage<string>>,
  store: ReturnType<typeof createStore>,
  stop: (message: StreamMessage<string>) => boolean,
) {
  for await (const message of stream) {
    store.apply(message);
    if (stop(message)) break;
  }
  await stream.return(undefined);
}

const expectedBlocks = (from: number, to: number) => {
  const expected: number[] = [];
  for (let n = from; n <= to; n++) if (eventBearing(n)) expected.push(n);
  return expected;
};

for (const withStore of [true, false]) {
  it(`${withStore ? "re-indexes" : "(without the store check) permanently loses"} a block a lagging read skipped just before a restart`, async () => {
    // EKU-272: a read whose log index lags the head reports the newest
    // event-bearing block as empty, and the tail message moves the cursor past
    // it. The next re-read would catch that -- unless the process restarts
    // first, and the new stream seeds its window from the chain.
    let lag = 1;
    const chain = faultyChain({ tip: 101, lagging: () => lag, regress: () => 0 });
    const store = createStore(96);

    await runUntil(
      createBlockStream({ adapter: chain.adapter, startingCursor: store.cursor, options }),
      store,
      (m) => m._tag === "data" && m.data.endCursor.orderKey === 101n,
    );
    expect([...store.blocks.keys()]).toEqual([97, 98, 100]);
    expect(store.cursor.orderKey).toBe(101n);

    lag = 0;
    chain.advance();
    await runUntil(
      createBlockStream({
        adapter: chain.adapter,
        startingCursor: store.cursor,
        loadStoredBlocks: withStore ? store.loadStoredBlocks : undefined,
        options,
      }),
      store,
      (m) => m._tag === "data" && m.data.endCursor.orderKey === 102n,
    );

    const stored = [...store.blocks.keys()].sort((a, b) => a - b);
    if (withStore) expect(stored).toEqual(expectedBlocks(97, 102));
    else expect(stored).not.toContain(101);
  });
}

it("converges on every event-bearing block through lagging reads, head regressions and restarts", async () => {
  // Deterministic, so a failure reproduces.
  let seed = 0x272;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  let faulty = true;
  const chain = faultyChain({
    tip: 20,
    lagging: () => (faulty && random() < 0.3 ? 1 + Math.floor(random() * 3) : 0),
    regress: () => (faulty && random() < 0.2 ? 1 + Math.floor(random() * 2) : 0),
  });
  const store = createStore(10);

  let restarts = 0;
  while (chain.tip < 200) {
    const stream = createBlockStream({
      adapter: chain.adapter,
      startingCursor: store.cursor,
      loadStoredBlocks: store.loadStoredBlocks,
      options,
    });
    await runUntil(stream, store, () => {
      if (random() < 0.5) chain.advance();
      return random() < 0.1;
    });
    restarts++;
  }

  // One healthy run to the tip, after which nothing may be missing.
  faulty = false;
  await runUntil(
    createBlockStream({
      adapter: chain.adapter,
      startingCursor: store.cursor,
      loadStoredBlocks: store.loadStoredBlocks,
      options,
    }),
    store,
    (m) => m._tag === "data" && Number(m.data.endCursor.orderKey) === chain.tip,
  );

  expect(restarts).toBeGreaterThan(10);
  expect([...store.blocks.keys()].sort((a, b) => a - b)).toEqual(expectedBlocks(11, chain.tip));
});
