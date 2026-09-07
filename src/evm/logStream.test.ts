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
          reorgWindowBlocks: 32,
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
          reorgWindowBlocks: 32,
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
          reorgWindowBlocks: 32,
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
          reorgWindowBlocks: 64,
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
          reorgWindowBlocks: 20,
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
          reorgWindowBlocks: 20,
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
          reorgWindowBlocks: 32,
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
          reorgWindowBlocks: 32,
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
          reorgWindowBlocks: 64,
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

describe("fetchLogsChecked error handling", () => {
  it("splits on the message Alchemy actually returns", async () => {
    const rpc = rpcDouble({
      logs: (from, to) => {
        if (to - from >= 5) throw rpcError(ALCHEMY_TOO_LARGE, -32602);
        return [log({ blockNumber: numberToHex(BigInt(from)) })];
      },
    });

    const logs = await fetchLogsChecked(rpc, {
      fromBlock: 1,
      toBlock: 10,
      addresses: [CORE],
      suspectLogCount: 10_000,
    });
    expect(logs).toHaveLength(2);
  });

  it("does not split a rate limit, even though it carries a numeric code", async () => {
    // Alchemy reports a compute-unit overage as a JSON-RPC error with code 429.
    // Bisecting it would aim a fan-out at an endpoint that just asked us to
    // slow down, which is the storm the split is supposed to avoid.
    const rpc = rpcDouble({
      logs: () => {
        throw rpcError("Your app has exceeded its compute units per second capacity.", 429);
      },
    });

    await expect(
      fetchLogsChecked(rpc, {
        fromBlock: 1,
        toBlock: 1_000,
        addresses: [CORE],
        suspectLogCount: 10_000,
      }),
    ).rejects.toThrow(/compute units/);
    expect(rpc.calls).toHaveLength(1);
  });

  it("does not split an Infura-style rate limit sharing the -32005 code", async () => {
    const rpc = rpcDouble({
      logs: () => {
        throw rpcError("daily request count exceeded, rate limit reached", -32005);
      },
    });

    await expect(
      fetchLogsChecked(rpc, {
        fromBlock: 1,
        toBlock: 1_000,
        addresses: [CORE],
        suspectLogCount: 10_000,
      }),
    ).rejects.toThrow(/rate limit/);
    expect(rpc.calls).toHaveLength(1);
  });

  it("splits an Infura-style result cap on the same code", async () => {
    const rpc = rpcDouble({
      logs: (from, to) => {
        if (to - from >= 5) {
          throw rpcError("query returned more than 10000 results", -32005);
        }
        return [log({ blockNumber: numberToHex(BigInt(from)) })];
      },
    });

    const logs = await fetchLogsChecked(rpc, {
      fromBlock: 1,
      toBlock: 10,
      addresses: [CORE],
      suspectLogCount: 10_000,
    });
    expect(logs).toHaveLength(2);
  });

  it("propagates an error it does not recognise rather than guessing", async () => {
    const rpc = rpcDouble({
      logs: () => {
        throw rpcError("something else went wrong", -32000);
      },
    });

    await expect(
      fetchLogsChecked(rpc, {
        fromBlock: 1,
        toBlock: 1_000,
        addresses: [CORE],
        suspectLogCount: 10_000,
      }),
    ).rejects.toThrow(/something else/);
    expect(rpc.calls).toHaveLength(1);
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
    ).rejects.toBeDefined();
  });
});

describe("groupLogsByBlock event index", () => {
  const inTx = (over: Partial<RawLog>) => log(over);

  it("numbers logs within their transaction, not within the block", () => {
    // event_index is packed into 16 bits by compute_event_id, so the block-wide
    // logIndex cannot be used: it counts every log in the block, including other
    // contracts', and would eventually exceed the range and wedge the worker.
    const [block] = groupLogsByBlock(
      [
        inTx({ transactionIndex: "0x0", logIndex: "0x7d0" }),
        inTx({ transactionIndex: "0x0", logIndex: "0x7d1" }),
        inTx({ transactionIndex: "0x1", logIndex: "0x7d2" }),
      ],
      [filter()],
    );

    expect(block!.logs.map((l) => l.logIndexInTransaction)).toEqual([0, 1, 0]);
    // The block-wide index is still carried, just not used as the event index.
    expect(block!.logs.map((l) => l.logIndex)).toEqual([2000, 2001, 2002]);
  });

  it("keeps the numbering dense when a log matches no filter", () => {
    // Counted over everything the address filter returned, so adding or removing
    // a processor does not shift the event_id of an already-indexed event.
    const [block] = groupLogsByBlock(
      [
        inTx({ transactionIndex: "0x0", logIndex: "0x0" }),
        inTx({ transactionIndex: "0x0", logIndex: "0x1", topics: [T1] }),
        inTx({ transactionIndex: "0x0", logIndex: "0x2" }),
      ],
      [filter()],
    );

    // The middle log matched nothing and is gone, but the third keeps index 2.
    expect(block!.logs.map((l) => l.logIndexInTransaction)).toEqual([0, 2]);
  });

  it("stays well inside the range a block-wide index would blow", () => {
    const logs = Array.from({ length: 50 }, (_, i) =>
      inTx({
        transactionIndex: numberToHex(BigInt(i)),
        logIndex: numberToHex(BigInt(70_000 + i)),
      }),
    );
    const [block] = groupLogsByBlock(logs, [filter()]);

    for (const entry of block!.logs) {
      expect(entry.logIndexInTransaction).toBeLessThan(65_536);
    }
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
          reorgWindowBlocks: 64,
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

describe("fetchLogsChecked on a transport failure", () => {
  it("does not bisect a timeout into a request storm", async () => {
    // A refused range is a statement about the range; a timeout or a 429 is
    // not. Splitting one would turn a single transient failure into a burst of
    // requests aimed at an endpoint that is already struggling.
    const rpc = rpcDouble({
      logs: () => {
        throw new Error("fetch failed");
      },
    });

    await expect(
      fetchLogsChecked(rpc, {
        fromBlock: 1,
        toBlock: 1_000,
        addresses: [CORE],
        suspectLogCount: 10_000,
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(rpc.calls).toHaveLength(1);
  });

  it("gives up on a single block, since there is nothing left to split", async () => {
    const rpc = rpcDouble({
      logs: () => {
        throw rpcError("query returned more than 10000 results", -32005);
      },
    });

    await expect(
      fetchLogsChecked(rpc, {
        fromBlock: 7,
        toBlock: 7,
        addresses: [CORE],
        suspectLogCount: 10_000,
      }),
    ).rejects.toThrow(/more than 10000 results/);
  });
});

describe("fetchLogsChecked when the body is too large", () => {
  it("splits a client-side response size failure", async () => {
    // Observed against production Alchemy: inside its block-range limit it
    // applies no result cap, so a busy span returns a body the HTTP layer
    // refuses. There is no JSON-RPC code on this one at all, which is why the
    // split is gated on the message rather than on the presence of a code.
    const rpc = rpcDouble({
      logs: (from, to) => {
        if (to - from >= 5) {
          throw new Error("HTTP response body exceeded the size limit.");
        }
        return [log({ blockNumber: numberToHex(BigInt(from)) })];
      },
    });

    const logs = await fetchLogsChecked(rpc, {
      fromBlock: 1,
      toBlock: 10,
      addresses: [CORE],
      suspectLogCount: 10_000,
    });
    expect(logs).toHaveLength(2);
  });
});
