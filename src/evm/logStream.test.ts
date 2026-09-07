import { describe, expect, it } from "bun:test";
import type { Address, Hex } from "viem";
import { numberToHex } from "viem";
import {
  createLogStream,
  digestBlocks,
  fetchLogsChecked,
  firstDivergentBlock,
  groupLogsByBlock,
  logMatchesFilter,
  type LogStreamFilter,
  type RawLog,
  type RpcLike,
  type StreamMessage,
} from "./logStream";

const CORE = "0x00000000000014aA86C5d3c41765bb24e11bd701" as Address;
const OTHER = "0x5555fF9Ff2757500BF4EE020DcfD0210CFfa41Be" as Address;
const T0 = `0x${"11".repeat(32)}` as Hex;
const T1 = `0x${"22".repeat(32)}` as Hex;

const filter = (over: Partial<LogStreamFilter> = {}): LogStreamFilter => ({
  id: 1,
  address: CORE,
  topics: [T0],
  strict: false,
  ...over,
});

function log(over: Partial<RawLog> = {}): RawLog {
  return {
    address: CORE,
    topics: [T0],
    data: "0x",
    blockHash: `0x${"ab".repeat(32)}`,
    blockNumber: numberToHex(100n),
    blockTimestamp: numberToHex(1_700_000_000n),
    transactionHash: `0x${"cd".repeat(32)}`,
    transactionIndex: "0x0",
    logIndex: "0x0",
    ...over,
  };
}

describe("logMatchesFilter", () => {
  it("matches on address and topic0", () => {
    expect(logMatchesFilter(log(), filter())).toBe(true);
  });

  it("ignores case in addresses and topics", () => {
    expect(
      logMatchesFilter(
        log({ address: CORE.toUpperCase() as Address }),
        filter({ topics: [T0.toUpperCase() as Hex] }),
      ),
    ).toBe(true);
  });

  it("rejects a different address", () => {
    expect(logMatchesFilter(log({ address: OTHER }), filter())).toBe(false);
  });

  it("treats null as a wildcard", () => {
    expect(
      logMatchesFilter(log({ topics: [T0, T1] }), filter({ topics: [null] })),
    ).toBe(true);
  });

  it("matches extra topics when not strict", () => {
    expect(logMatchesFilter(log({ topics: [T0, T1] }), filter())).toBe(true);
  });

  it("requires an exact topic count when strict", () => {
    expect(
      logMatchesFilter(log({ topics: [T0, T1] }), filter({ strict: true })),
    ).toBe(false);
    expect(logMatchesFilter(log({ topics: [T0] }), filter({ strict: true }))).toBe(
      true,
    );
  });

  it("matches an anonymous event declared as strict with no topics", () => {
    expect(
      logMatchesFilter(
        log({ topics: [] }),
        filter({ topics: [], strict: true }),
      ),
    ).toBe(true);
  });
});

describe("groupLogsByBlock", () => {
  it("groups by block, orders blocks and logs, and carries the header", () => {
    const blocks = groupLogsByBlock(
      [
        log({ blockNumber: numberToHex(101n), logIndex: "0x5", blockHash: "0xbb" }),
        log({ blockNumber: numberToHex(100n), logIndex: "0x2", blockHash: "0xaa" }),
        log({ blockNumber: numberToHex(100n), logIndex: "0x1", blockHash: "0xaa" }),
      ],
      [filter()],
    );

    expect(blocks.map((b) => Number(b.header.blockNumber))).toEqual([100, 101]);
    expect(blocks[0]!.logs.map((l) => l.logIndex)).toEqual([1, 2]);
    expect(blocks[0]!.header.blockHash).toBe("0xaa");
    expect(blocks[0]!.header.timestamp).toEqual(new Date(1_700_000_000 * 1000));
  });

  it("drops logs flagged removed", () => {
    expect(groupLogsByBlock([log({ removed: true })], [filter()])).toEqual([]);
  });

  it("drops logs that match no filter and records ids for those that do", () => {
    const blocks = groupLogsByBlock(
      [log(), log({ address: OTHER, logIndex: "0x1" })],
      [filter(), filter({ id: 2, address: OTHER })],
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.logs.map((l) => l.filterIds)).toEqual([[1], [2]]);
  });

  it("records every matching filter for one log", () => {
    const blocks = groupLogsByBlock(
      [log()],
      [filter(), filter({ id: 7, topics: [] })],
    );
    expect(blocks[0]!.logs[0]!.filterIds).toEqual([1, 7]);
  });
});

describe("firstDivergentBlock", () => {
  const digest = (entries: [number, string, number][]) =>
    new Map(entries.map(([n, hash, logCount]) => [n, { hash: hash as Hex, logCount }]));

  it("returns undefined when the window agrees", () => {
    const a = digest([[10, "0xaa", 1]]);
    expect(firstDivergentBlock(a, digest([[10, "0xaa", 1]]), 1, 20)).toBeUndefined();
  });

  it("catches a block that changed hash", () => {
    expect(
      firstDivergentBlock(digest([[10, "0xaa", 1]]), digest([[10, "0xbb", 1]]), 1, 20),
    ).toBe(10);
  });

  it("catches a block whose logs disappeared", () => {
    expect(firstDivergentBlock(digest([[10, "0xaa", 1]]), digest([]), 1, 20)).toBe(10);
  });

  it("catches logs appearing in a block that had none", () => {
    expect(firstDivergentBlock(digest([]), digest([[10, "0xaa", 1]]), 1, 20)).toBe(10);
  });

  it("catches a block that kept its hash but changed log count", () => {
    expect(
      firstDivergentBlock(digest([[10, "0xaa", 1]]), digest([[10, "0xaa", 2]]), 1, 20),
    ).toBe(10);
  });

  it("reports the lowest divergent block", () => {
    expect(
      firstDivergentBlock(
        digest([
          [10, "0xaa", 1],
          [12, "0xcc", 1],
        ]),
        digest([
          [10, "0xzz", 1],
          [12, "0xdd", 1],
        ]),
        1,
        20,
      ),
    ).toBe(10);
  });

  it("ignores blocks outside the re-read range", () => {
    expect(
      firstDivergentBlock(digest([[5, "0xaa", 1]]), digest([]), 10, 20),
    ).toBeUndefined();
  });
});

/** Minimal RPC double that records every method it was asked for. */
function rpcDouble(handlers: {
  logs?: (from: number, to: number) => RawLog[];
  blocks?: (tag: string) => { number: number; hash: string; timestamp: number } | null;
}): RpcLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request: (async (args: { method: string; params: unknown[] }) => {
      calls.push(args.method);
      if (args.method === "eth_getLogs") {
        const p = args.params[0] as { fromBlock: Hex; toBlock: Hex };
        return handlers.logs?.(Number(p.fromBlock), Number(p.toBlock)) ?? [];
      }
      if (args.method === "eth_getBlockByNumber") {
        const tag = args.params[0] as string;
        const b = handlers.blocks?.(tag);
        return b
          ? {
              number: numberToHex(BigInt(b.number)),
              hash: b.hash,
              timestamp: numberToHex(BigInt(b.timestamp)),
            }
          : null;
      }
      throw new Error(`unexpected ${args.method}`);
    }) as RpcLike["request"],
  };
}

describe("fetchLogsChecked", () => {
  it("returns a response comfortably under the cap", async () => {
    const rpc = rpcDouble({ logs: () => [log(), log()] });
    expect(await fetchLogsChecked(rpc, {
      fromBlock: 1,
      toBlock: 10,
      addresses: [CORE],
      suspectLogCount: 100,
    })).toHaveLength(2);
    expect(rpc.calls).toEqual(["eth_getLogs"]);
  });

  it("splits the range when a response lands exactly on the cap", async () => {
    // Exactly at the cap for the full range, under it once split.
    const rpc = rpcDouble({
      logs: (from, to) => (to - from >= 9 ? [log(), log()] : [log()]),
    });
    const logs = await fetchLogsChecked(rpc, {
      fromBlock: 1,
      toBlock: 10,
      addresses: [CORE],
      suspectLogCount: 2,
    });
    expect(logs).toHaveLength(2);
    // One refused call, then the two halves.
    expect(rpc.calls.length).toBe(3);
  });

  it("refuses rather than indexing short when a single block is at the cap", async () => {
    const rpc = rpcDouble({ logs: () => [log(), log()] });
    await expect(
      fetchLogsChecked(rpc, {
        fromBlock: 5,
        toBlock: 5,
        addresses: [CORE],
        suspectLogCount: 2,
      }),
    ).rejects.toThrow(/cannot be distinguished from a truncated one/);
  });
});

/**
 * Drives the stream until `count` messages arrive or `until` is satisfied.
 *
 * The stream is infinite and goes quiet once it reaches the head, so a driver
 * that only counts would hang on any test whose interesting message is the last
 * one. `deadlineMs` bounds that rather than leaving it to the test timeout.
 */
async function take(
  stream: AsyncGenerator<StreamMessage>,
  count: number,
  until?: (messages: StreamMessage[]) => boolean,
  deadlineMs = 2_000,
): Promise<StreamMessage[]> {
  const out: StreamMessage[] = [];
  const deadline = Date.now() + deadlineMs;

  const race = async () => {
    for await (const message of stream) {
      out.push(message);
      if (out.length >= count) return;
      if (until?.(out)) return;
      if (Date.now() > deadline) return;
    }
  };

  await Promise.race([
    race(),
    new Promise((resolve) => setTimeout(resolve, deadlineMs)),
  ]);
  return out;
}

describe("createLogStream", () => {
  it("emits matching blocks in order and advances the cursor to the head", async () => {
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 90, hash: "0x90", timestamp: 1_700_000_000 }
          : { number: 103, hash: "0x103", timestamp: 1_700_000_030 },
      logs: (from, to) =>
        [101, 102]
          .filter((n) => n >= from && n <= to)
          .map((n) =>
            log({
              blockNumber: numberToHex(BigInt(n)),
              blockHash: `0x${n}` as Hex,
            }),
          ),
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: { pollIntervalMs: 1, finalizedRefreshIntervalMs: 1_000_000 },
      }),
      4,
    );

    const data = messages.filter((m) => m._tag === "data");
    expect(data.map((m) => Number(m.data.endCursor.orderKey))).toEqual([
      101, 102, 103,
    ]);
    // The trailing block carries no logs but moves the cursor to the head.
    expect(data.at(-1)!.data.data[0]!.logs).toHaveLength(0);
    expect(data[0]!.data.data[0]!.header.blockHash).toBe("0x101");
  });

  it("does not fetch a header for any block other than the head", async () => {
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 95, hash: "0x95", timestamp: 1_700_000_000 }
          : { number: 105, hash: "0x105", timestamp: 1_700_000_000 },
      logs: () => [
        log({ blockNumber: numberToHex(101n), blockHash: "0x101" }),
        log({ blockNumber: numberToHex(104n), blockHash: "0x104", logIndex: "0x1" }),
      ],
    });

    await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: { pollIntervalMs: 1, finalizedRefreshIntervalMs: 1_000_000 },
      }),
      3,
    );

    // Two blocks carried logs and the head advanced by five, yet the only
    // header reads are for tags, never per block.
    const headerReads = rpc.calls.filter((c) => c === "eth_getBlockByNumber");
    expect(headerReads.length).toBeLessThanOrEqual(2);
  });

  it("does not mistake a quiet chain for a reorg", async () => {
    // Regression: the trailing block that moves the cursor carries no logs, so
    // a re-read of the window can never confirm it. Recording it made every
    // poll on a chain with no matching events look like a reorg.
    const warnings: string[] = [];
    let height = 100;
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 50, hash: "0x50", timestamp: 1_700_000_000 }
          : { number: (height += 7), hash: `0x${height}`, timestamp: 1_700_000_000 },
      logs: () => [],
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          reorgWindowBlocks: 32,
          onWarning: (m) => warnings.push(m),
        },
      }),
      8,
      undefined,
      1_000,
    );

    expect(messages.filter((m) => m._tag === "invalidate")).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    // It still advances: each poll emits the trailing block for the new head.
    expect(messages.filter((m) => m._tag === "data").length).toBeGreaterThan(1);
  });

  it("invalidates back to the block before a changed hash", async () => {
    let pass = 0;
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 90, hash: "0x90", timestamp: 1_700_000_000 }
          : { number: 102, hash: "0x102", timestamp: 1_700_000_000 },
      logs: () => {
        pass++;
        // First read sees 101 under one hash, later reads under another.
        return [
          log({
            blockNumber: numberToHex(101n),
            blockHash: pass <= 1 ? "0xaaa" : "0xbbb",
          }),
        ];
      },
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          reorgWindowBlocks: 16,
        },
      }),
      10,
      (m) => m.some((x) => x._tag === "invalidate"),
    );

    const invalidate = messages.find((m) => m._tag === "invalidate");
    expect(invalidate).toBeDefined();
    expect(Number(invalidate!.invalidate.cursor.orderKey)).toBe(100);
  });

  it("ignores a finalized block that moves backwards", async () => {
    const warnings: string[] = [];
    let finalizedCall = 0;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized") {
          finalizedCall++;
          return finalizedCall === 1
            ? { number: 95, hash: "0x95", timestamp: 1_700_000_000 }
            : { number: 90, hash: "0x90", timestamp: 1_700_000_000 };
        }
        return { number: 100, hash: "0x100", timestamp: 1_700_000_000 };
      },
      logs: () => [],
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1,
          onWarning: (m) => warnings.push(m),
        },
      }),
      10,
      () => warnings.some((w) => w.includes("backwards")),
    );

    const finalizes = messages.filter((m) => m._tag === "finalize");
    // Only the forward move is announced; the rewind is refused, not fatal.
    expect(finalizes.every((f) => Number(f.finalize.cursor.orderKey) === 95)).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("backwards"))).toBe(true);
  });
});

describe("digestBlocks", () => {
  it("summarises a block by hash and log count", () => {
    const blocks = groupLogsByBlock([log(), log({ logIndex: "0x1" })], [filter()]);
    const digests = digestBlocks(blocks);
    expect(digests.get(100)).toEqual({
      hash: `0x${"ab".repeat(32)}`,
      logCount: 2,
    });
  });
});
