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
  observeBlockRate,
  pollIntervalFor,
  reorgWindowBlocksFor,
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
  blocks?: (tag: string) => {
    number: number;
    hash: string;
    timestamp: number;
    baseFeePerGas?: bigint;
  } | null;
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
              ...(b.baseFeePerGas !== undefined
                ? { baseFeePerGas: numberToHex(b.baseFeePerGas) }
                : {}),
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
          // A window of 32: it is capped at half the span.
          maxLogRangeBlocks: 64,
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
    // A block hash commits to its ancestry, so a chain that changed at 101
    // cannot still present the same head. The reorg is driven from the head
    // read, and 101 changes hash with it.
    let headReads = 0;
    const reorged = () => headReads > 2;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return { number: 90, hash: "0x90", timestamp: 1_700_000_000 };
        headReads++;
        return {
          number: 102,
          hash: reorged() ? "0x102b" : "0x102a",
          timestamp: 1_700_000_000,
        };
      },
      logs: () => [
        log({
          blockNumber: numberToHex(101n),
          blockHash: reorged() ? "0xbbb" : "0xaaa",
        }),
      ],
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          // A window of 16: it is capped at half the span.
          maxLogRangeBlocks: 32,
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

describe("createLogStream, once caught up", () => {
  it("emits nothing further while the head stands still", async () => {
    // Every data message costs the runtime a write transaction. A head that has
    // not moved must not produce one, or thirteen workers churn the database
    // every poll forever.
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 90, hash: "0x90", timestamp: 1_700_000_000 }
          : { number: 100, hash: "0x100", timestamp: 1_700_000_000 },
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
          heartbeatIntervalMs: 1_000_000,
          // A window of 32: it is capped at half the span.
          maxLogRangeBlocks: 64,
        },
      }),
      4,
      undefined,
      300,
    );

    expect(messages.filter((m) => m._tag === "data")).toHaveLength(0);
    // It kept polling rather than stalling. The window read is skipped while the
    // head is unchanged, so the head read is what shows the loop still running.
    expect(
      rpc.calls.filter((c) => c === "eth_getBlockByNumber").length,
    ).toBeGreaterThan(2);
  });

  it("still emits the trailing block when the head has moved", async () => {
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 90, hash: "0x90", timestamp: 1_700_000_000 }
          : { number: 101, hash: "0x101", timestamp: 1_700_000_000 },
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
          heartbeatIntervalMs: 1_000_000,
          // A window of 32: it is capped at half the span.
          maxLogRangeBlocks: 64,
        },
      }),
      3,
      undefined,
      300,
    );

    const data = messages.filter((m) => m._tag === "data");
    expect(data).toHaveLength(1);
    expect(data[0]!.data.endCursor.orderKey).toBe(101n);
  });
});

describe("createLogStream finalized handling", () => {
  it("holds back a finalized block that is ahead of the cursor", async () => {
    // The runtime's recovery path resets the cursor to the last finalized one.
    // Announcing a finalized block past ours would let that jump the cursor
    // forward on the next unhandled error, skipping every block in between.
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 150, hash: "0x150", timestamp: 1_700_000_000 }
          : { number: 200, hash: "0x200", timestamp: 1_700_000_000 },
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
          heartbeatIntervalMs: 1_000_000,
          // A window of 32: it is capped at half the span.
          maxLogRangeBlocks: 64,
        },
      }),
      4,
      undefined,
      400,
    );

    // Nothing was announced before the cursor reached 200.
    expect(messages[0]!._tag).toBe("data");
    const finalizes = messages.filter((m) => m._tag === "finalize");
    expect(finalizes.length).toBeGreaterThan(0);
    // And when it is announced it is still 150, never ahead of where we are.
    for (const message of finalizes) {
      if (message._tag !== "finalize") continue;
      expect(message.finalize.cursor.orderKey).toBe(150n);
    }
  });

  it("does not skip blocks when finality overtakes the cursor", async () => {
    // On a sub-second-finality chain the finalized block can pass a cursor that
    // fell a few blocks behind. Clamping the re-read to the finalized block
    // would then start it above the cursor and drop 96..98 without a word.
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 98, hash: "0x98", timestamp: 1_700_000_000 }
          : { number: 100, hash: "0x100", timestamp: 1_700_000_000 },
      logs: (from, to) =>
        97 >= from && 97 <= to
          ? [
              log({
                blockNumber: numberToHex(97n),
                blockHash: "0x97",
                blockTimestamp: numberToHex(1_700_000_000n),
              }),
            ]
          : [],
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 95n },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          heartbeatIntervalMs: 1_000_000,
          // A window of 64: it is capped at half the span.
          maxLogRangeBlocks: 128,
        },
      }),
      3,
      (out) => out.some((m) => m._tag === "data"),
      400,
    );

    const blocks = messages.flatMap((m) =>
      m._tag === "data" ? m.data.data.map((b) => b.header.blockNumber) : [],
    );
    expect(blocks).toContain(97n);
  });
});

describe("createLogStream on restart", () => {
  const canonical = `0x${"7f".repeat(32)}` as Hex;

  const restartRpc = (cursorHash: string) =>
    rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return { number: 50, hash: "0x50", timestamp: 1_700_000_000 };
        if (tag === "latest")
          return { number: 110, hash: "0x110", timestamp: 1_700_000_000 };
        // A numbered read: only the cursor block is ever asked for by number.
        return { number: 100, hash: cursorHash, timestamp: 1_700_000_000 };
      },
      logs: (from, to) =>
        [98, 99]
          .filter((n) => n >= from && n <= to)
          .map((n) =>
            log({
              blockNumber: numberToHex(BigInt(n)),
              blockHash: `0x${n}` as Hex,
              blockTimestamp: numberToHex(1_700_000_000n),
            }),
          ),
    });

  const run = (rpc: RpcLike, warnings: string[]) =>
    take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n, uniqueKey: canonical },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          heartbeatIntervalMs: 1_000_000,
          // A window of 20: it is capped at half the span.
          maxLogRangeBlocks: 40,
          onWarning: (m) => warnings.push(m),
        },
      }),
      3,
      (out) => out.some((m) => m._tag === "data"),
      400,
    );

  it("rolls back when the stored cursor is no longer canonical", async () => {
    const warnings: string[] = [];
    const messages = await run(restartRpc(`0x${"11".repeat(32)}`), warnings);

    const first = messages[0]!;
    expect(first._tag).toBe("invalidate");
    // Back to cursor minus the reorg window, so the window is re-read.
    if (first._tag === "invalidate") {
      expect(first.invalidate.cursor.orderKey).toBe(79n);
    }
    expect(warnings[0]).toMatch(/not canonical/);
  });

  it("does not roll back when the stored cursor still matches", async () => {
    // The first window read is a baseline, not a disagreement. Diffing against
    // an empty map would invalidate on every deploy.
    const warnings: string[] = [];
    const messages = await run(restartRpc(canonical), warnings);

    expect(messages.filter((m) => m._tag === "invalidate")).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("compares cursor hashes by value, since the column drops leading zeroes", async () => {
    const stored = "0x0f" as Hex;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return { number: 50, hash: "0x50", timestamp: 1_700_000_000 };
        if (tag === "latest")
          return { number: 110, hash: "0x110", timestamp: 1_700_000_000 };
        return { number: 100, hash: `0x${"0".repeat(63)}f`, timestamp: 1 };
      },
      logs: () => [],
    });

    const warnings: string[] = [];
    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n, uniqueKey: stored },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          heartbeatIntervalMs: 1_000_000,
          // A window of 20: it is capped at half the span.
          maxLogRangeBlocks: 40,
          onWarning: (m) => warnings.push(m),
        },
      }),
      2,
      (out) => out.some((m) => m._tag === "data"),
      400,
    );

    expect(messages.filter((m) => m._tag === "invalidate")).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

describe("createLogStream when the head repeats", () => {
  it("skips the window re-read while the head is unchanged", async () => {
    // The re-read is 60 of the 80 compute units a poll costs. An identical head
    // means an identical chain, so there is nothing it could find.
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 90, hash: "0x90", timestamp: 1_700_000_000 }
          : { number: 100, hash: "0x100", timestamp: 1_700_000_000 },
      logs: () => [],
    });

    await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          heartbeatIntervalMs: 1_000_000,
          // A window of 32: it is capped at half the span.
          maxLogRangeBlocks: 64,
        },
      }),
      4,
      undefined,
      300,
    );

    const heads = rpc.calls.filter((c) => c === "eth_getBlockByNumber").length;
    const reads = rpc.calls.filter((c) => c === "eth_getLogs").length;
    // It kept polling the head...
    expect(heads).toBeGreaterThan(5);
    // ...but only read the window on the tick that seeded it.
    expect(reads).toBe(1);
  });

  it("re-reads when the head keeps the number but changes hash", async () => {
    // A one-block reorg leaves the height alone. Skipping on height would miss
    // it, so the short circuit compares hashes.
    let polls = 0;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return { number: 90, hash: "0x90", timestamp: 1_700_000_000 };
        polls++;
        return {
          number: 100,
          hash: polls > 2 ? "0xbbb" : "0xaaa",
          timestamp: 1_700_000_000,
        };
      },
      logs: () => [],
    });

    await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          heartbeatIntervalMs: 1_000_000,
          // A window of 32: it is capped at half the span.
          maxLogRangeBlocks: 64,
        },
      }),
      4,
      undefined,
      300,
    );

    expect(rpc.calls.filter((c) => c === "eth_getLogs").length).toBeGreaterThan(
      1,
    );
  });
});

describe("createLogStream startup rollback depth", () => {
  it("does not rewind past the finalized block", async () => {
    // A finalized block cannot be the reorg point, and the rows below it are
    // settled, so there is no reason to throw them away.
    const warnings: string[] = [];
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return { number: 95, hash: "0x95", timestamp: 1_700_000_000 };
        if (tag === "latest")
          return { number: 110, hash: "0x110", timestamp: 1_700_000_000 };
        return {
          number: 100,
          hash: `0x${"11".repeat(32)}`,
          timestamp: 1_700_000_000,
        };
      },
      logs: () => [],
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: {
          orderKey: 100n,
          uniqueKey: `0x${"7f".repeat(32)}` as Hex,
        },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          heartbeatIntervalMs: 1_000_000,
          // A window of 64: it is capped at half the span.
          maxLogRangeBlocks: 128,
          onWarning: (m) => warnings.push(m),
        },
      }),
      2,
      (out) => out.some((m) => m._tag === "data"),
      400,
    );

    const first = messages[0]!;
    expect(first._tag).toBe("invalidate");
    // Window would reach back to 36; finality stops it at 95.
    if (first._tag === "invalidate") {
      expect(first.invalidate.cursor.orderKey).toBe(95n);
    }
    expect(warnings[0]).toMatch(/not canonical/);
  });
});

// The exact text Alchemy returns for an oversized eth_getLogs, as viem
// surfaces it (viem appends the server's `Details:` to the message). Captured
// from the production endpoint rather than guessed, since the split is gated on
// matching it and a guess that misses turns a backfill into a crash loop.
const ALCHEMY_TOO_LARGE =
  "Invalid parameters were provided to the RPC method.\n" +
  "Double check you have provided the correct parameters.\n\n" +
  "Request body: {\"method\":\"eth_getLogs\"}\n\n" +
  "Details: Log response size exceeded. You can make eth_getLogs requests " +
  "with up to a 5,000 block range and no limit on the response size, or you " +
  "can request any block range with a cap of 10K logs in the response.";

function rpcError(message: string, code: number): Error {
  const error = new Error(message) as Error & { code: number };
  error.code = code;
  return error;
}

describe("groupLogsByBlock event index", () => {
  it("carries the block-wide log index through unchanged", () => {
    // event_index in evm.ts is this value. The apibara RPC stream never
    // populated logIndexInTransaction either, so keeping it identical is what
    // makes this a stream swap rather than a change to a primary key.
    const [block] = groupLogsByBlock(
      [
        log({ transactionIndex: "0x0", logIndex: "0x7d0" }),
        log({ transactionIndex: "0x0", logIndex: "0x7d1" }),
        log({ transactionIndex: "0x1", logIndex: "0x7d2" }),
      ],
      [filter()],
    );

    expect(block!.logs.map((l) => l.logIndex)).toEqual([2000, 2001, 2002]);
  });

  it("names the cause when an index cannot be represented", () => {
    // compute_event_id packs event_index into 16 bits and raises above 65,535.
    // Inherited limitation, but it should not surface as a confusing failure
    // inside a Postgres function several layers away from its cause.
    expect(() =>
      groupLogsByBlock(
        [log({ blockNumber: numberToHex(500n), logIndex: numberToHex(70_000n) })],
        [filter()],
      ),
    ).toThrow(/compute_event_id cannot represent/);
  });

  it("accepts an index just inside the limit", () => {
    const [block] = groupLogsByBlock(
      [log({ logIndex: numberToHex(65_535n) })],
      [filter()],
    );
    expect(block!.logs[0]!.logIndex).toBe(65_535);
  });
});

describe("createLogStream configuration", () => {
  it("refuses a span too narrow to both re-read and advance", async () => {
    const rpc = rpcDouble({ logs: () => [] });

    await expect(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: { maxLogRangeBlocks: 1 },
      }).next(),
    ).rejects.toThrow(/at least 2/);
  });

  it("cannot be configured into a window that outruns the span", async () => {
    // The old failure this replaces: a window wider than the span it has to fit
    // inside ends every read below the cursor, so nothing is emitted, the cursor
    // never advances, and -- since the span never reaches the head -- the loop
    // never sleeps. A busy spin that looks like a healthy worker.
    //
    // It used to be rejected at construction. Now it is unreachable: the window
    // is capped at half the span, so at least half of every read is forward
    // progress no matter how long `reorgWindowSeconds` is or how fast the chain
    // runs. There is no configuration left to refuse.
    for (const seconds of [1, 120, 86_400]) {
      for (const rate of [null, 0.1, 11, 100_000]) {
        const window = reorgWindowBlocksFor(
          { blockRate: rate },
          { reorgWindowSeconds: seconds, maxLogRangeBlocks: 1_000 },
        );
        expect(window).toBeLessThanOrEqual(500);
        expect(window).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("accepts the tightest span that can still make progress", async () => {
    // Two blocks: one re-read, one new. The window is capped at half the span,
    // so this is the narrowest configuration that is not degenerate.
    const rpc = rpcDouble({
      blocks: () => ({ number: 100, hash: "0x100", timestamp: 1_700_000_000 }),
      logs: () => [],
    });

    const stream = createLogStream({
      rpc,
      filters: [filter()],
      startingCursor: { orderKey: 100n },
      options: {
        maxLogRangeBlocks: 2,
        pollIntervalMs: 1,
        heartbeatIntervalMs: 1,
      },
    });
    await expect(stream.next()).resolves.toBeDefined();
  });
});

describe("createLogStream cursor safety", () => {
  it("does not rewind the cursor when the head answers behind it", async () => {
    // A backend momentarily behind the load balancer yields a plan that ends
    // below the cursor. Taking it would rewind the in-memory cursor with no
    // invalidate and no warning, and block 100 -- already indexed, which is what
    // the starting cursor means -- would be emitted a second time once the head
    // recovered.
    let headReads = 0;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return { number: 30, hash: "0x30", timestamp: 1_700_000_000 };
        headReads++;
        // First poll sees a stale backend, then the head recovers.
        return headReads <= 1
          ? { number: 99, hash: "0x99", timestamp: 1_700_000_000 }
          : { number: 101, hash: "0x101", timestamp: 1_700_000_000 };
      },
      logs: (from, to) =>
        [100, 101]
          .filter((n) => n >= from && n <= to)
          .map((n) =>
            log({
              blockNumber: numberToHex(BigInt(n)),
              blockHash: `0x${n}` as Hex,
              blockTimestamp: numberToHex(1_700_000_000n),
            }),
          ),
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          heartbeatIntervalMs: 1_000_000,
          // A window of 64: it is capped at half the span.
          maxLogRangeBlocks: 128,
        },
      }),
      8,
      (out) =>
        out.some(
          (m) =>
            m._tag === "data" &&
            m.data.data.some((b) => Number(b.header.blockNumber) === 101),
        ),
      600,
    );

    // Block 100 may legitimately be re-read -- that is what the reorg window is
    // for -- but only ever announced, never silently. The invariant is that
    // nothing already indexed is re-emitted without an invalidate ahead of it,
    // because that is what makes the re-index a replacement rather than a
    // duplicate.
    const firstReemit = messages.findIndex(
      (m) =>
        m._tag === "data" &&
        m.data.data.some((b) => Number(b.header.blockNumber) <= 100),
    );
    const firstInvalidate = messages.findIndex((m) => m._tag === "invalidate");

    if (firstReemit !== -1) {
      expect(firstInvalidate).not.toBe(-1);
      expect(firstInvalidate).toBeLessThan(firstReemit);
    }
    expect(
      messages.flatMap((m) =>
        m._tag === "data"
          ? m.data.data.map((b) => Number(b.header.blockNumber))
          : [],
      ),
    ).toContain(101);
  });
});

describe("createLogStream finalized announcements", () => {
  it("announces finality on a chain that finalises near the head", async () => {
    // The refresh happens at the top of a tick, when the cursor still holds last
    // tick's value. On a fast-finality chain that stale cursor is always behind
    // the finalized block, so checking there and only there would mute the
    // message permanently and freeze finalized_order_key.
    // `head` is where our cursor got to last poll. The chain has moved on since,
    // so when finality is read at the top of a tick it is already ahead of the
    // cursor -- which is exactly the condition that would mute it forever.
    let head = 100;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return { number: head + 4, hash: `0xf${head}`, timestamp: 1_700_000_000 };
        head += 5;
        return { number: head, hash: `0x${head}`, timestamp: 1_700_000_000 };
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
          heartbeatIntervalMs: 1_000_000,
          // A window of 32: it is capped at half the span.
          maxLogRangeBlocks: 64,
        },
      }),
      10,
      (out) => out.some((m) => m._tag === "finalize"),
      600,
    );

    const finalizes = messages.filter((m) => m._tag === "finalize");
    expect(finalizes.length).toBeGreaterThan(0);
  });

  it("never announces finality ahead of the cursor", async () => {
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 150, hash: "0x150", timestamp: 1_700_000_000 }
          : { number: 200, hash: "0x200", timestamp: 1_700_000_000 },
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
          heartbeatIntervalMs: 1_000_000,
          // A window of 32: it is capped at half the span.
          maxLogRangeBlocks: 64,
        },
      }),
      6,
      undefined,
      400,
    );

    // Data for the tail comes first; finality only once the cursor passed it.
    expect(messages[0]!._tag).toBe("data");
    for (const message of messages) {
      if (message._tag !== "finalize") continue;
      expect(message.finalize.cursor.orderKey).toBe(150n);
    }
  });
});

describe("createLogStream rollback cursor", () => {
  it("carries the landing block's hash so a restart can still verify it", async () => {
    // Without a uniqueKey the stored cursor has nothing to check against, and a
    // restart in the window right after a reorg would skip verification
    // entirely -- after the one event that makes it worth doing.
    let headReads = 0;
    const reorged = () => headReads > 2;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return { number: 90, hash: "0x90", timestamp: 1_700_000_000 };
        headReads++;
        return {
          number: 103,
          hash: reorged() ? "0x103b" : "0x103a",
          timestamp: 1_700_000_000,
        };
      },
      // 101 keeps its hash; 102 changes, so the rollback lands on 101.
      logs: () =>
        [
          log({
            blockNumber: numberToHex(101n),
            blockHash: "0xaaa",
            logIndex: "0x0",
          }),
          log({
            blockNumber: numberToHex(102n),
            blockHash: reorged() ? "0xccc" : "0xbbb",
            logIndex: "0x1",
          }),
        ],
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 100n },
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
          heartbeatIntervalMs: 1_000_000,
          // A window of 16: it is capped at half the span.
          maxLogRangeBlocks: 32,
        },
      }),
      12,
      (out) => out.some((m) => m._tag === "invalidate"),
      800,
    );

    const invalidate = messages.find((m) => m._tag === "invalidate");
    expect(invalidate).toBeDefined();
    if (invalidate?._tag === "invalidate") {
      expect(invalidate.invalidate.cursor.orderKey).toBe(101n);
      expect(invalidate.invalidate.cursor.uniqueKey).toBe("0xaaa");
    }
  });
});
describe("fetchLogsChecked on an eth_getLogs error", () => {
  // These are the real phrasings, captured live from the endpoints this repo
  // uses. An earlier version tried to recognise them and split; they are kept
  // here to pin the opposite property, that none of them is treated specially.
  // A provider rewording one must not be able to change what the stream does.
  const REFUSALS = [
    ["base", "eth_getLogs is limited to a 10,000 range"],
    ["ink", "block range greater than 10000 max"],
    ["optimism", "Block range is too large"],
    ["alchemy", "Log response size exceeded. You can make eth_getLogs requests"],
    ["infura", "query returned more than 10000 results"],
    ["body", "HTTP response body exceeded the size limit."],
    ["throttle", "Your app has exceeded its compute units per second capacity."],
    ["unknown", "something nobody has seen before"],
  ] as const;

  for (const [name, message] of REFUSALS) {
    it(`fails fast on the ${name} phrasing, in one request`, async () => {
      const rpc = rpcDouble({
        logs: () => {
          throw new Error(message);
        },
      });

      await expect(
        fetchLogsChecked(rpc, {
          fromBlock: 1,
          toBlock: 1_000,
          addresses: [CORE],
          suspectLogCount: 10_000,
        }),
      ).rejects.toThrow(/eth_getLogs failed for blocks 1\.\.1000/);
      // No bisection: the range is ours to choose, so a refusal is a
      // configuration problem to surface, not one to work around.
      expect(rpc.calls).toHaveLength(1);
    });
  }

  it("names the range and the knob, and keeps the original as the cause", async () => {
    const original = new Error("Block range is too large");
    const rpc = rpcDouble({
      logs: () => {
        throw original;
      },
    });

    const failure = await fetchLogsChecked(rpc, {
      fromBlock: 500,
      toBlock: 1_499,
      addresses: [CORE],
      suspectLogCount: 10_000,
    }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).not.toBeNull();
    if (!failure) return;

    expect(failure.message).toContain("500..1499");
    expect(failure.message).toContain("1000 blocks");
    expect(failure.message).toContain("GET_LOGS_RANGE_SIZE");
    // The provider's own words survive for diagnosis, they just do not steer.
    expect(failure.message).toContain("Block range is too large");
    expect((failure as { cause?: unknown }).cause).toBe(original);
  });

  it("survives a thrown non-object", async () => {
    const rpc = rpcDouble({
      logs: () => {
        throw "a string, not an Error";
      },
    });

    await expect(
      fetchLogsChecked(rpc, {
        fromBlock: 1,
        toBlock: 10,
        addresses: [CORE],
        suspectLogCount: 10_000,
      }),
    ).rejects.toThrow(/a string, not an Error/);
  });
});

describe("fetchLogsChecked at the suspect count", () => {
  it("still splits a successful response sitting exactly on the cap", async () => {
    // The one split that remains. It keys off a count we were handed rather
    // than text a provider chose, so it cannot rot the way matching does.
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
    expect(rpc.calls.length).toBe(3);
  });

  it("believes a response that overshoots the cap", async () => {
    // Only landing exactly on the cap is ambiguous. Going over proves no cap
    // was applied, and inside Alchemy's block-range limit there is none at all.
    const rpc = rpcDouble({ logs: () => [log(), log(), log()] });

    const logs = await fetchLogsChecked(rpc, {
      fromBlock: 5,
      toBlock: 5,
      addresses: [CORE],
      suspectLogCount: 2,
    });
    expect(logs).toHaveLength(3);
    expect(rpc.calls).toHaveLength(1);
  });

  it("refuses a single block sitting exactly on the cap", async () => {
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

describe("createLogStream head base fee", () => {
  // indexer_cursor.head_base_fee_per_gas is the only surviving consumer of a
  // base fee (00122 moved it off blocks, 00127 drops the column). The runtime
  // writes it from every block it processes, so a log-derived block carrying
  // null would blank out the value the quoter prices gas with.
  const headBaseFee = 12_345_678n;

  const streamWith = (logsFor: number[]) =>
    createLogStream({
      rpc: rpcDouble({
        blocks: (tag) =>
          tag === "finalized"
            ? { number: 90, hash: "0x90", timestamp: 1_700_000_000 }
            : {
                number: 103,
                hash: "0x103",
                timestamp: 1_700_000_000,
                baseFeePerGas: headBaseFee,
              },
        logs: (from, to) =>
          logsFor
            .filter((n) => n >= from && n <= to)
            .map((n) =>
              log({
                blockNumber: numberToHex(BigInt(n)),
                blockHash: `0x${n}` as Hex,
                blockTimestamp: numberToHex(1_700_000_000n),
              }),
            ),
      }),
      filters: [filter()],
      startingCursor: { orderKey: 100n },
      options: {
        pollIntervalMs: 1,
        finalizedRefreshIntervalMs: 1_000_000,
        heartbeatIntervalMs: 1_000_000,
        // A window of 32: it is capped at half the span.
        maxLogRangeBlocks: 64,
      },
    });

  it("gives the head block its own base fee", async () => {
    // 103 is the head, so its real value is already in hand from this poll's
    // latest-block read and it carries it. Blocks below the head report null,
    // which is honest -- the DAO coalesces rather than blanking the column.
    const messages = await take(streamWith([101, 102, 103]), 6, undefined, 400);

    const blocks = messages.flatMap((m) => (m._tag === "data" ? m.data.data : []));
    const head = blocks.find((b) => Number(b.header.blockNumber) === 103);
    expect(head).toBeDefined();
    expect(head!.header.baseFeePerGas).toBe(headBaseFee);
  });

  it("carries it on the trailing block of a quiet chain too", async () => {
    const messages = await take(streamWith([]), 4, undefined, 400);

    const blocks = messages.flatMap((m) => (m._tag === "data" ? m.data.data : []));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.header.baseFeePerGas).toBe(headBaseFee);
    }
  });
});

describe("pollIntervalFor", () => {
  const opts = {
    pollIntervalMs: 2_000,
    maxPollIntervalMs: 30_000,
    quietPollsBeforeBackoff: 30,
    // Wide enough that the drain ceiling never binds in these cases; the tests
    // that exercise it say so.
    maxLogRangeBlocks: 1_000_000,
    reorgWindowSeconds: 120,
  };
  const at = (quietPolls: number, blockRate: number | null = 0.5) => ({
    quietPolls,
    blockRate,
  });

  it("holds at the floor for the whole quiet allowance", () => {
    // The latency guarantee: a chain that indexed anything in the last
    // pollIntervalMs * quietPollsBeforeBackoff keeps polling at full rate.
    for (const quiet of [0, 1, 29, 30]) {
      expect(pollIntervalFor(at(quiet), opts)).toBe(2_000);
    }
  });

  it("doubles per quiet poll past the allowance, then caps", () => {
    expect(pollIntervalFor(at(31), opts)).toBe(4_000);
    expect(pollIntervalFor(at(32), opts)).toBe(8_000);
    expect(pollIntervalFor(at(33), opts)).toBe(16_000);
    expect(pollIntervalFor(at(34), opts)).toBe(30_000);
    expect(pollIntervalFor(at(3_000), opts)).toBe(30_000);
  });

  it("never returns Infinity for a chain quiet for a very long time", () => {
    // 2 ** 1024 is Infinity, and a chain quiet for a week gets that far. The
    // Math.min would still return the ceiling, but the intermediate is a trap.
    expect(
      Number.isFinite(pollIntervalFor(at(Number.MAX_SAFE_INTEGER), opts)),
    ).toBe(true);
  });

  it("is disabled by setting the ceiling to the floor", () => {
    const off = { ...opts, maxPollIntervalMs: 2_000 };
    expect(pollIntervalFor(at(10_000), off)).toBe(2_000);
  });

  it("never returns less than the floor, even if the ceiling is below it", () => {
    const bad = { ...opts, maxPollIntervalMs: 5 };
    expect(pollIntervalFor(at(10_000), bad)).toBe(2_000);
  });

  it("will not sleep for longer than one eth_getLogs can drain", () => {
    // The block-rate dependency that would otherwise be an assumption. A span
    // of 1000 with a 120s window on an 11 blocks/s chain leaves 1000 - 1000/2
    // = 500 blocks of drain, which that chain produces in ~45s -- so the
    // configured 60s ceiling must give way to ~45s. Sleeping past it means the
    // stream cannot catch up in one read, stops sleeping, and reads back to
    // back: more compute units than it saved.
    const fast = {
      ...opts,
      maxPollIntervalMs: 60_000,
      maxLogRangeBlocks: 1_000,
    };
    const interval = pollIntervalFor(at(10_000, 11), fast);
    expect(interval).toBeLessThan(60_000);
    expect(interval).toBeCloseTo((500 / 11) * 1_000, -2);
  });

  it("uses the configured ceiling on a chain slow enough to drain it", () => {
    // Ethereum at 0.1 blocks/s produces 6 blocks in a minute against 500 of
    // drain, so nothing about the block rate constrains it.
    const slow = {
      ...opts,
      maxPollIntervalMs: 60_000,
      maxLogRangeBlocks: 1_000,
    };
    expect(pollIntervalFor(at(10_000, 0.1), slow)).toBe(60_000);
  });

  it("does not let an unmeasured rate constrain the ceiling", () => {
    expect(pollIntervalFor(at(10_000, null), opts)).toBe(30_000);
  });
});

describe("observeBlockRate", () => {
  const head = (number: number, timeSec: number) => ({
    number,
    hash: "0x0" as Hex,
    timestamp: new Date(timeSec * 1_000),
    baseFeePerGas: null,
  });
  const fresh = () => ({ blockRate: null, rateSample: null }) as never;

  it("does not let a short baseline talk the rate down", () => {
    // Block timestamps have one-second resolution and Robinhood fits eleven
    // blocks inside one, so a short baseline measures rounding, not the chain.
    // Everything the rate sizes is safe wide and unsafe narrow, so a partial
    // baseline may raise it but must never lower it.
    const state = fresh() as { blockRate: number | null; rateSample: unknown };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(1_330, 1_700_000_030));
    expect(state.blockRate).toBeCloseTo(11, 5);

    // A quiet second that would imply 1 block/s leaves the rate alone.
    observeBlockRate(state as never, head(1_331, 1_700_000_031));
    expect(state.blockRate).toBeCloseTo(11, 5);
  });

  it("never adopts a rate of zero from a tip replaced in place", () => {
    // A null rate makes the rise-only comparison adopt anything, so a head that
    // keeps its number but gains a later timestamp would store zero -- and a
    // zero rate sizes the reorg window down to one block.
    const state = fresh() as { blockRate: number | null; rateSample: unknown };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(1_000, 1_700_000_005));
    expect(state.blockRate).not.toBe(0);
    expect(state.blockRate).toBeNull();
  });

  it("adopts a rate increase without waiting for a full baseline", () => {
    // A sequencer catching up after downtime. Waiting the full sample would
    // leave the window sized for the old, slower chain while blocks pile up
    // past the end of it.
    const state = fresh() as { blockRate: number | null; rateSample: unknown };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(1_030, 1_700_000_030));
    expect(state.blockRate).toBeCloseTo(1, 5);

    observeBlockRate(state as never, head(1_530, 1_700_000_035));
    expect(state.blockRate).toBeCloseTo(100, 5);
  });

  it("measures the rate once the baseline is long enough", () => {
    const state = fresh() as { blockRate: number | null; rateSample: unknown };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(1_330, 1_700_000_030));
    expect(state.blockRate).toBeCloseTo(11, 5);
  });

  it("restarts the baseline rather than believing a head that went backwards", () => {
    // A provider serving an older view is not a negative block rate.
    const state = fresh() as { blockRate: number | null; rateSample: unknown };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(900, 1_700_000_030));
    expect(state.blockRate).toBeNull();
    observeBlockRate(state as never, head(1_230, 1_700_000_060));
    expect(state.blockRate).toBeCloseTo(11, 5);
  });
});

describe("reorgWindowBlocksFor", () => {
  const opts = { reorgWindowSeconds: 120, maxLogRangeBlocks: 1_000 };

  it("reports a capped window once, not on every poll", async () => {
    // The warning deliberately does not live in `reorgWindowBlocksFor`: four
    // call sites size themselves from it per tick, so a warning in there is
    // four identical lines a poll forever.
    const warnings: { message: string; detail: Record<string, unknown> }[] = [];
    let poll = 0;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized") {
          return { number: 900, hash: "0x900", timestamp: 1_700_000_000 };
        }
        // 11 blocks a second, sampled over a full baseline.
        const step = poll++;
        return {
          number: 1_000 + step * 330,
          hash: `0x${step}`,
          timestamp: 1_700_000_000 + step * 30,
        };
      },
      logs: () => [],
    });

    await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 1_000n },
        options: {
          pollIntervalMs: 1,
          maxPollIntervalMs: 1,
          reorgWindowSeconds: 120,
          maxLogRangeBlocks: 1_000,
          finalizedRefreshIntervalMs: 1_000_000,
          onWarning: (message, detail) => warnings.push({ message, detail }),
        },
      }),
      20,
      undefined,
      400,
    );

    const capped = warnings.filter((w) =>
      /capped by the log range size/.test(w.message),
    );
    // 11 blocks/s wants 1320 against a 500 cap, so it is capped -- and said once.
    expect(capped).toHaveLength(1);
    expect(capped[0]!.detail.cappedToBlocks).toBe(500);
    expect(capped[0]!.detail.effectiveSeconds).toBe(45);
  });

  it("says nothing when the window fits inside the span", async () => {
    const warnings: string[] = [];
    let poll = 0;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized") {
          return { number: 900, hash: "0x900", timestamp: 1_700_000_000 };
        }
        const step = poll++;
        return {
          number: 1_000 + step * 3,
          hash: `0x${step}`,
          timestamp: 1_700_000_000 + step * 30,
        };
      },
      logs: () => [],
    });

    await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 1_000n },
        options: {
          pollIntervalMs: 1,
          maxPollIntervalMs: 1,
          reorgWindowSeconds: 120,
          maxLogRangeBlocks: 1_000,
          finalizedRefreshIntervalMs: 1_000_000,
          onWarning: (m) => warnings.push(m),
        },
      }),
      20,
      undefined,
      400,
    );

    expect(warnings.filter((w) => /capped/.test(w))).toEqual([]);
  });

  it("means the same amount of history on chains 100x apart in block time", () => {
    // The whole point. 64 blocks bought Ethereum 640s of protection and
    // Robinhood 6s; 120 seconds buys both 120 seconds.
    expect(reorgWindowBlocksFor({ blockRate: 0.1 }, opts)).toBe(12);
    expect(reorgWindowBlocksFor({ blockRate: 3.8 }, opts)).toBe(456);
  });

  it("takes the widest window on offer until the rate is known", () => {
    // Erring wide is free -- one eth_getLogs is 60 units for any span it
    // accepts -- and erring narrow loses events.
    expect(reorgWindowBlocksFor({ blockRate: null }, opts)).toBe(500);
  });

  it("never exceeds half the span, however fast the chain", () => {
    expect(reorgWindowBlocksFor({ blockRate: 11 }, opts)).toBe(500);
    expect(reorgWindowBlocksFor({ blockRate: 100_000 }, opts)).toBe(500);
  });

  it("never collapses to zero on a chain that has barely moved", () => {
    expect(reorgWindowBlocksFor({ blockRate: 0.0000001 }, opts)).toBe(1);
  });
});

describe("reorg detection once the poll interval can back off", () => {
  it("re-reads the window even when the head has run far past it", async () => {
    // The regression that backing off introduces. `windowFor` used to read back
    // from `head - reorgWindowBlocks`, and only while the head was within that
    // distance of the cursor. At a two-second poll that was every chain, always.
    // At a thirty-second poll an L2 advances hundreds of blocks between polls,
    // so a caught-up stream looks exactly like one that is catching up, takes
    // the read-forward branch, and never looks at a block it already emitted.
    //
    // Drive the head independently of the log reads: a double whose head only
    // moves when `logs` is called cannot exercise this at all.
    let poll = 0;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized") {
          return { number: 900, hash: "0x900", timestamp: 1_700_000_000 };
        }
        // Poll 1 sits just above the cursor; poll 2 has run 490 blocks past it,
        // far beyond the 8-block reorg window.
        poll++;
        return poll <= 2
          ? { number: 1010, hash: "0x1010", timestamp: 1_700_000_010 }
          : { number: 1500, hash: "0x1500", timestamp: 1_700_000_600 };
      },
      logs: (from, to) => {
        // Block 1005 changes hash once the head has moved on -- a reorg of a
        // block this stream has already emitted.
        const hash = poll <= 2 ? "0xaaa" : "0xbbb";
        return 1005 >= from && 1005 <= to
          ? [log({ blockNumber: numberToHex(1005n), blockHash: hash as Hex })]
          : [];
      },
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 1000n },
        options: {
          pollIntervalMs: 1,
          // Window of 50, comfortably covering block 1005 below the cursor.
          maxLogRangeBlocks: 100,
          finalizedRefreshIntervalMs: 1_000_000,
        },
      }),
      12,
      (out) => out.some((m) => m._tag === "invalidate"),
    );

    const invalidate = messages.find((m) => m._tag === "invalidate");
    expect(invalidate).toBeDefined();
    // Rolls back to just below the block that changed.
    expect(Number(invalidate!.invalidate.cursor.orderKey)).toBe(1004);
  });

  it("still reads forward, not backward, while catching up from far behind", async () => {
    // The window hangs below the cursor, so a backfill overlaps its last read
    // by the width of the window and never stalls or rewinds.
    const spans: [number, number][] = [];
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 500, hash: "0x500", timestamp: 1_700_000_000 }
          : { number: 100_000, hash: "0xhead", timestamp: 1_700_100_000 },
      logs: (from, to) => {
        spans.push([from, to]);
        return [];
      },
    });

    await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 1000n },
        options: {
          pollIntervalMs: 1,
          maxLogRangeBlocks: 1_000,
          finalizedRefreshIntervalMs: 1_000_000,
        },
      }),
      3,
    );

    expect(spans.length).toBeGreaterThanOrEqual(2);
    // First read starts one window below the cursor, not at the cursor. The
    // rate is unmeasured on the first poll, so the window is the cap -- half of
    // maxLogRangeBlocks, 500.
    expect(spans[0]).toEqual([501, 1_500]);
    // And it makes real forward progress: at least half the span per read,
    // which is what the cap guarantees against any block rate.
    expect(spans[1]![0]).toBe(1_001);
    expect(spans[1]![0] - spans[0]![0]).toBeGreaterThanOrEqual(500);
  });
});

describe("poll backoff on a quiet chain", () => {
  /** Counts eth_getLogs over a fixed wall-clock window on a chain that never emits. */
  async function pollsInWindow(options: {
    pollIntervalMs: number;
    maxPollIntervalMs: number;
    quietPollsBeforeBackoff: number;
  }): Promise<number> {
    let head = 5_000;
    const rpc = rpcDouble({
      // The head advances every poll, as it does on every chain we index whose
      // block time is under the poll interval. That is what makes the existing
      // unchanged-head skip useless there, and what leaves the interval as the
      // only lever.
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 4_000, hash: "0x4000", timestamp: 1_700_000_000 }
          : { number: head++, hash: `0x${head}`, timestamp: 1_700_000_000 },
      logs: () => [],
    });

    const stream = createLogStream({
      rpc,
      filters: [filter()],
      startingCursor: { orderKey: 5_000n },
      options: { ...options, finalizedRefreshIntervalMs: 1_000_000 },
    });

    const deadline = Date.now() + 400;
    void (async () => {
      for await (const _ of stream) {
        if (Date.now() > deadline) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 400));
    return rpc.calls.filter((c) => c === "eth_getLogs").length;
  }

  it("settles at the ceiling instead of the floor", async () => {
    const backedOff = await pollsInWindow({
      pollIntervalMs: 2,
      maxPollIntervalMs: 200,
      quietPollsBeforeBackoff: 2,
    });

    // Asserted as an absolute ceiling rather than a ratio against a second run.
    // A ratio needs the un-backed-off arm to stay fast, and a contended CI
    // runner slows that arm toward this one and fails a test about backoff for
    // reasons that have nothing to do with backoff. Contention can only make
    // this number smaller, which is the safe direction: 400ms at a 200ms
    // ceiling is 2-3 polls plus the few at the floor before it ramps, against
    // ~200 with backoff off.
    expect(backedOff).toBeGreaterThan(0);
    expect(backedOff).toBeLessThanOrEqual(12);
  });

  it("keeps polling at the floor while the chain keeps producing events", async () => {
    // A busy chain must never notice backoff exists.
    let head = 5_000;
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 4_000, hash: "0x4000", timestamp: 1_700_000_000 }
          : { number: ++head, hash: `0x${head}`, timestamp: 1_700_000_000 },
      logs: (from, to) =>
        [
          log({
            blockNumber: numberToHex(BigInt(to)),
            blockHash: `0x${to}` as Hex,
          }),
        ].filter(() => to >= from),
    });

    const stream = createLogStream({
      rpc,
      filters: [filter()],
      startingCursor: { orderKey: 5_000n },
      options: {
        pollIntervalMs: 2,
        maxPollIntervalMs: 200,
        quietPollsBeforeBackoff: 2,
        finalizedRefreshIntervalMs: 1_000_000,
      },
    });

    const deadline = Date.now() + 300;
    void (async () => {
      for await (const _ of stream) {
        if (Date.now() > deadline) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 300));

    // At a 2ms floor over 300ms this is ~150 reads; at the 200ms ceiling it
    // would be one or two. The threshold is set far below the expected count
    // and far above the ceiling's, so only an interval that actually grew can
    // fail it -- not a slow runner.
    expect(rpc.calls.filter((c) => c === "eth_getLogs").length).toBeGreaterThan(
      10,
    );
  });
});

describe("a measured window that changes width", () => {
  it("does not invent a reorg when the window grows", async () => {
    // The window is measured, so it widens when the chain speeds up. If
    // `emitted` were pruned to the window in force when a tick ended, the next
    // tick's wider scan would cover blocks it had just forgotten, and
    // `firstDivergentBlock` cannot tell "I forgot this" from "this is new below
    // my cursor" -- it reports a reorg, `rollbackTo` clears the rest of the
    // map, and the next tick does it again, walking the cursor backwards.
    //
    // Nothing in this chain ever reorgs: every hash is a pure function of its
    // block number. Any invalidate is therefore fabricated.
    let poll = 0;
    // Slow, slower, then slow again -- the middle patch shrinks the measured
    // rate and the recovery grows it back, which is the transition that bit.
    const heads = [
      { n: 1_000, t: 1_700_000_000 },
      { n: 1_003, t: 1_700_000_036 },
      { n: 1_004, t: 1_700_000_072 },
      { n: 1_007, t: 1_700_000_108 },
      { n: 1_010, t: 1_700_000_144 },
      { n: 1_013, t: 1_700_000_180 },
    ];
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized") {
          return { number: 800, hash: "0x800", timestamp: 1_700_000_000 };
        }
        const h = heads[Math.min(poll++, heads.length - 1)]!;
        return { number: h.n, hash: `0x${h.n}`, timestamp: h.t };
      },
      // Every block carries a log, and its hash depends only on its number.
      logs: (from, to) => {
        const out: RawLog[] = [];
        for (let n = from; n <= to; n++) {
          out.push(
            log({
              blockNumber: numberToHex(BigInt(n)),
              blockHash: `0x${n}` as Hex,
              blockTimestamp: numberToHex(BigInt(1_700_000_000 + n)),
            }),
          );
        }
        return out;
      },
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 1_000n },
        options: {
          pollIntervalMs: 1,
          maxPollIntervalMs: 1,
          reorgWindowSeconds: 360,
          maxLogRangeBlocks: 200,
          finalizedRefreshIntervalMs: 1_000_000,
        },
      }),
      40,
      undefined,
      600,
    );

    expect(messages.filter((m) => m._tag === "invalidate")).toEqual([]);
  });
});

describe("a rollback that moves the cursor down", () => {
  it("does not fabricate a second reorg below the retention floor", async () => {
    // `rollbackTo` lowers the cursor and `continue`s, skipping `finishTick` --
    // so a real reorg moves the cursor down without lowering the floor
    // `emitted` was last pruned to. The next cursor-anchored scan then starts a
    // full window below where that prune assumed, and every log-bearing block
    // in the gap reads as `before === undefined, after !== undefined`: a
    // fabricated reorg, which clears the rest of the map so the next tick has
    // nothing to diff against and does it again.
    //
    // One real reorg here, at block 1180. Everything below it is stable -- its
    // hash is a pure function of its number -- so exactly one invalidate is
    // correct and any further one is invented.
    let poll = 0;
    const reorgAt = 1_180;
    const hashFor = (n: number) =>
      (n === reorgAt && poll > 2 ? `0x${n}-b` : `0x${n}-a`) as Hex;

    const rpc = rpcDouble({
      blocks: (tag) => {
        // No finality floor to hide behind: `earliest` stays at 1, which is the
        // condition that makes the gap reachable.
        if (tag === "finalized") return null;
        poll++;
        return {
          number: 1_200 + poll,
          hash: `0xhead${poll}`,
          timestamp: 1_700_000_000 + poll,
        };
      },
      logs: (from, to) => {
        const out: RawLog[] = [];
        for (let n = Math.max(from, 1); n <= to; n++) {
          out.push(
            log({
              blockNumber: numberToHex(BigInt(n)),
              blockHash: hashFor(n),
              blockTimestamp: numberToHex(BigInt(1_700_000_000 + n)),
            }),
          );
        }
        return out;
      },
    });

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 1_200n },
        options: {
          pollIntervalMs: 1,
          maxPollIntervalMs: 1,
          // Unmeasured rate parks the window at the cap (50), which is the
          // width at which the gap opens.
          maxLogRangeBlocks: 100,
          reorgWindowSeconds: 120,
          finalizedRefreshIntervalMs: 1_000_000,
        },
      }),
      60,
      undefined,
      800,
    );

    const invalidates = messages.filter((m) => m._tag === "invalidate");
    // The one real reorg, and nothing else. Before the retention floor was
    // honoured this walked the cursor down repeatedly.
    expect(invalidates.length).toBeLessThanOrEqual(1);
  });
});

describe("observeBlockRate on a halted chain", () => {
  const head = (number: number, timeSec: number) => ({
    number,
    hash: "0x0" as Hex,
    timestamp: new Date(timeSec * 1_000),
    baseFeePerGas: null,
  });

  it("a full baseline that saw no blocks keeps the last known rate", () => {
    // A halted sequencer whose tip is replaced in place still advances the
    // timestamp, so the baseline completes with `advanced === 0`. Dividing
    // stores a rate of zero, and a zero rate sizes the reorg window down to one
    // block -- on the very poll that has to reconcile the reorg that resumes
    // the chain.
    const state = { blockRate: null, rateSample: null } as never as {
      blockRate: number | null;
      rateSample: unknown;
    };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(1_330, 1_700_000_030));
    expect(state.blockRate).toBeCloseTo(11, 5);

    // 60s pass, tip replaced at the same height.
    observeBlockRate(state as never, head(1_330, 1_700_000_090));
    expect(state.blockRate).toBeCloseTo(11, 5);
  });

  it("a short first sample does not narrow the window below the cap", () => {
    // With no rate yet the window is already the cap, the widest available, so
    // adopting a one-second sample is a narrowing dressed as a rise.
    const state = { blockRate: null, rateSample: null } as never as {
      blockRate: number | null;
      rateSample: unknown;
    };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(1_005, 1_700_000_001));
    expect(state.blockRate).toBeNull();
  });
});
