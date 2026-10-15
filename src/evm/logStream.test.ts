import { describe, expect, it } from "bun:test";
import type { Address, Hex } from "viem";
import { numberToHex } from "viem";
import { readSnapshot } from "../_shared/blockSnapshot";
import {
  createLogStream,
  createEvmAdapter,
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
    expect(
      logMatchesFilter(log({ topics: [T0] }), filter({ strict: true })),
    ).toBe(true);
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
        log({
          blockNumber: numberToHex(101n),
          logIndex: "0x5",
          blockHash: "0xbb",
        }),
        log({
          blockNumber: numberToHex(100n),
          logIndex: "0x2",
          blockHash: "0xaa",
        }),
        log({
          blockNumber: numberToHex(100n),
          logIndex: "0x1",
          blockHash: "0xaa",
        }),
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
    new Map(
      entries.map(([n, hash, logCount]) => [
        n,
        { hash: hash as Hex, logCount },
      ]),
    );

  it("returns undefined when the window agrees", () => {
    const a = digest([[10, "0xaa", 1]]);
    expect(
      firstDivergentBlock(a, digest([[10, "0xaa", 1]]), 1, 20),
    ).toBeUndefined();
  });

  it("catches a block that changed hash", () => {
    expect(
      firstDivergentBlock(
        digest([[10, "0xaa", 1]]),
        digest([[10, "0xbb", 1]]),
        1,
        20,
      ),
    ).toBe(10);
  });

  it("catches a block whose logs disappeared", () => {
    expect(
      firstDivergentBlock(digest([[10, "0xaa", 1]]), digest([]), 1, 20),
    ).toBe(10);
  });

  it("catches logs appearing in a block that had none", () => {
    expect(
      firstDivergentBlock(digest([]), digest([[10, "0xaa", 1]]), 1, 20),
    ).toBe(10);
  });

  it("catches a block that kept its hash but changed log count", () => {
    expect(
      firstDivergentBlock(
        digest([[10, "0xaa", 1]]),
        digest([[10, "0xaa", 2]]),
        1,
        20,
      ),
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
  const headers = new Map<
    number,
    { number: number; hash: string; timestamp: number; baseFeePerGas?: bigint }
  >();
  const getLogs = (params: unknown[]) => {
    const p = params[0] as { fromBlock: Hex; toBlock: Hex };
    const logs = handlers.logs?.(Number(p.fromBlock), Number(p.toBlock)) ?? [];
    for (const log of logs) {
      headers.set(Number(log.blockNumber), {
        number: Number(log.blockNumber),
        hash: log.blockHash,
        timestamp: Number(log.blockTimestamp ?? "0x0"),
      });
    }
    return logs;
  };
  const getBlock = (tag: string) => {
    const b = headers.get(Number(tag)) ?? handlers.blocks?.(tag);
    if (!b) return null;
    const number =
      tag === "latest" || tag === "finalized" ? b.number : Number(tag);
    headers.set(number, b);
    return {
      number: numberToHex(BigInt(number)),
      hash: b.hash,
      timestamp: numberToHex(BigInt(b.timestamp)),
      ...(b.baseFeePerGas !== undefined
        ? { baseFeePerGas: numberToHex(b.baseFeePerGas) }
        : {}),
    };
  };
  return {
    calls,
    request: (async (args: { method: string; params: unknown[] }) => {
      calls.push(args.method);
      if (args.method === "eth_getLogs") return getLogs(args.params);
      if (args.method === "eth_getBlockByNumber")
        return getBlock(args.params[0] as string);
      throw new Error(`unexpected ${args.method}`);
    }) as RpcLike["request"],
  };
}

describe("fetchLogsChecked", () => {
  it("returns a response comfortably under the cap", async () => {
    const rpc = rpcDouble({ logs: () => [log(), log()] });
    expect(
      await fetchLogsChecked(rpc, {
        fromBlock: 1,
        toBlock: 10,
        addresses: [CORE],
        suspectLogCount: 100,
      }),
    ).toHaveLength(2);
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
    expect(data.at(-1)!.data.data[0]!.logs).toHaveLength(0);
    expect(data[0]!.data.data[0]!.header.blockHash).toBe("0x101");
  });

  it("bounds header reads per quiet range rather than per block", async () => {
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 95, hash: "0x95", timestamp: 1_700_000_000 }
          : { number: 105, hash: "0x105", timestamp: 1_700_000_000 },
      logs: () => [
        log({ blockNumber: numberToHex(101n), blockHash: "0x101" }),
        log({
          blockNumber: numberToHex(104n),
          blockHash: "0x104",
          logIndex: "0x1",
        }),
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

    const headerReads = rpc.calls.filter((c) => c === "eth_getBlockByNumber");
    expect(headerReads.length).toBeLessThanOrEqual(5);
  });

  it("does not mistake a quiet chain for a reorg", async () => {
    const warnings: string[] = [];
    let height = 100;
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 50, hash: "0x50", timestamp: 1_700_000_000 }
          : {
              number: (height += 7),
              hash: `0x${height}`,
              timestamp: 1_700_000_000,
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
          finalizedRefreshIntervalMs: 1_000_000,
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
    expect(messages.filter((m) => m._tag === "data").length).toBeGreaterThan(1);
  });

  it("invalidates back to the block before a changed hash", async () => {
    let headReads = 0;
    const reorged = () => headReads > 2;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return { number: 90, hash: "0x90", timestamp: 1_700_000_000 };
        if (tag === "0x64")
          return { number: 100, hash: "0x100", timestamp: 1_700_000_000 };
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
        startingCursor: { orderKey: 100n, uniqueKey: "0x100" },
        loadPreviousCursor: async () => ({
          orderKey: 100n,
          uniqueKey: "0x100",
        }),
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1_000_000,
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

  it("rolls a quiet chain back to the finalized block, not its last stored event", async () => {
    let headReads = 0;
    const reorged = () => headReads > 6;
    const calls: string[] = [];
    const header = (number: number, hash: string) => ({
      number: numberToHex(BigInt(number)),
      hash,
      timestamp: numberToHex(1_700_000_000n),
    });
    const rpc: RpcLike = {
      request: (async (args: { method: string; params: unknown[] }) => {
        calls.push(args.method);
        if (args.method === "eth_getLogs") return [];
        const tag = args.params[0] as string;
        if (tag === "finalized") return header(990, "0x990");
        if (tag === "latest") {
          headReads++;
          return reorged() ? header(1006, "0x1006b") : header(1005, "0x1005");
        }
        const n = Number(tag);
        return header(n, reorged() && n > 1000 ? `0x${n}b` : `0x${n}`);
      }) as RpcLike["request"],
    };

    const messages = await take(
      createLogStream({
        rpc,
        filters: [filter()],
        startingCursor: { orderKey: 1000n, uniqueKey: "0x1000" },
        loadPreviousCursor: async (before) =>
          before > 20 ? { orderKey: 20n, uniqueKey: "0x20" } : null,
        options: {
          pollIntervalMs: 1,
          finalizedRefreshIntervalMs: 1,
          maxLogRangeBlocks: 64,
        },
      }),
      50,
      (m) => m.some((x) => x._tag === "invalidate"),
    );

    const invalidate = messages.find((m) => m._tag === "invalidate");
    expect(invalidate).toBeDefined();
    expect(invalidate!.invalidate.cursor).toEqual({
      orderKey: 990n,
      uniqueKey: "0x990",
    });
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
    expect(
      finalizes.every((f) => Number(f.finalize.cursor.orderKey) === 95),
    ).toBe(true);
    expect(warnings.some((w) => w.includes("backwards"))).toBe(true);
  });
});

describe("digestBlocks", () => {
  it("summarises a block by hash and log count", () => {
    const blocks = groupLogsByBlock(
      [log(), log({ logIndex: "0x1" })],
      [filter()],
    );
    const digests = digestBlocks(blocks);
    expect(digests.get(100)).toEqual({
      hash: `0x${"ab".repeat(32)}`,
      logCount: 2,
    });
  });
});

describe("createLogStream, once caught up", () => {
  it("emits nothing further while the head stands still", async () => {
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
          maxLogRangeBlocks: 64,
        },
      }),
      4,
      undefined,
      300,
    );

    expect(messages.filter((m) => m._tag === "data")).toHaveLength(0);
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
          maxLogRangeBlocks: 64,
        },
      }),
      4,
      undefined,
      400,
    );

    expect(messages[0]!._tag).toBe("data");
    const finalizes = messages.filter((m) => m._tag === "finalize");
    expect(finalizes.length).toBeGreaterThan(0);
    for (const message of finalizes) {
      if (message._tag !== "finalize") continue;
      expect(message.finalize.cursor.orderKey).toBe(150n);
    }
  });

  it("does not skip blocks when finality overtakes the cursor", async () => {
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
    if (first._tag === "invalidate") {
      expect(first.invalidate.cursor.orderKey).toBe(0n);
    }
    expect(warnings[0]).toMatch(/not canonical/);
  });

  it("does not roll back when the stored cursor still matches", async () => {
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
          maxLogRangeBlocks: 64,
        },
      }),
      4,
      undefined,
      300,
    );

    const heads = rpc.calls.filter((c) => c === "eth_getBlockByNumber").length;
    const reads = rpc.calls.filter((c) => c === "eth_getLogs").length;
    expect(heads).toBeGreaterThan(5);
    expect(reads).toBe(1);
  });

  it("re-reads when the head keeps the number but changes hash", async () => {
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
  it("rewinds past newly observed finality when the stored cursor differs", async () => {
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
    if (first._tag === "invalidate") {
      expect(first.invalidate.cursor.orderKey).toBe(0n);
    }
    expect(warnings[0]).toMatch(/not canonical/);
  });
});

const ALCHEMY_TOO_LARGE =
  "Invalid parameters were provided to the RPC method.\n" +
  "Double check you have provided the correct parameters.\n\n" +
  'Request body: {"method":"eth_getLogs"}\n\n' +
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
    expect(() =>
      groupLogsByBlock(
        [
          log({
            blockNumber: numberToHex(500n),
            logIndex: numberToHex(70_000n),
          }),
        ],
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
    let headReads = 0;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return { number: 30, hash: "0x30", timestamp: 1_700_000_000 };
        headReads++;
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
    let head = 100;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized")
          return {
            number: head + 4,
            hash: `0xf${head}`,
            timestamp: 1_700_000_000,
          };
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
          maxLogRangeBlocks: 64,
        },
      }),
      6,
      undefined,
      400,
    );

    expect(messages[0]!._tag).toBe("data");
    for (const message of messages) {
      if (message._tag !== "finalize") continue;
      expect(message.finalize.cursor.orderKey).toBe(150n);
    }
  });
});

describe("createLogStream rollback cursor", () => {
  it("carries the landing block's hash so a restart can still verify it", async () => {
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
      logs: () => [
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
  const REFUSALS = [
    ["base", "eth_getLogs is limited to a 10,000 range"],
    ["ink", "block range greater than 10000 max"],
    ["optimism", "Block range is too large"],
    [
      "alchemy",
      "Log response size exceeded. You can make eth_getLogs requests",
    ],
    ["infura", "query returned more than 10000 results"],
    ["body", "HTTP response body exceeded the size limit."],
    [
      "throttle",
      "Your app has exceeded its compute units per second capacity.",
    ],
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
        maxLogRangeBlocks: 64,
      },
    });

  it("gives the head block its own base fee", async () => {
    const messages = await take(streamWith([101, 102, 103]), 6, undefined, 400);

    const blocks = messages.flatMap((m) =>
      m._tag === "data" ? m.data.data : [],
    );
    const head = blocks.find((b) => Number(b.header.blockNumber) === 103);
    expect(head).toBeDefined();
    expect(head!.header.baseFeePerGas).toBe(headBaseFee);
  });

  it("carries it on the trailing block of a quiet chain too", async () => {
    const messages = await take(streamWith([]), 4, undefined, 400);

    const blocks = messages.flatMap((m) =>
      m._tag === "data" ? m.data.data : [],
    );
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
    maxLogRangeBlocks: 1_000_000,
    reorgWindowSeconds: 120,
  };
  const at = (quietPolls: number, blockRate: number | null = 0.5) => ({
    quietPolls,
    blockRate,
  });

  it("holds at the floor for the whole quiet allowance", () => {
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
    const state = fresh() as { blockRate: number | null; rateSample: unknown };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(1_330, 1_700_000_030));
    expect(state.blockRate).toBeCloseTo(11, 5);

    observeBlockRate(state as never, head(1_331, 1_700_000_031));
    expect(state.blockRate).toBeCloseTo(11, 5);
  });

  it("never adopts a rate of zero from a tip replaced in place", () => {
    const state = fresh() as { blockRate: number | null; rateSample: unknown };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(1_000, 1_700_000_005));
    expect(state.blockRate).not.toBe(0);
    expect(state.blockRate).toBeNull();
  });

  it("adopts a rate increase without waiting for a full baseline", () => {
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
    const warnings: { message: string; detail: Record<string, unknown> }[] = [];
    let poll = 0;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized") {
          return { number: 900, hash: "0x900", timestamp: 1_700_000_000 };
        }
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
    expect(reorgWindowBlocksFor({ blockRate: 0.1 }, opts)).toBe(12);
    expect(reorgWindowBlocksFor({ blockRate: 3.8 }, opts)).toBe(456);
  });

  it("takes the widest window on offer until the rate is known", () => {
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
    let poll = 0;
    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized") {
          return { number: 900, hash: "0x900", timestamp: 1_700_000_000 };
        }
        poll++;
        return poll <= 2
          ? { number: 1010, hash: "0x1010", timestamp: 1_700_000_010 }
          : { number: 1500, hash: "0x1500", timestamp: 1_700_000_600 };
      },
      logs: (from, to) => {
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
          maxLogRangeBlocks: 100,
          finalizedRefreshIntervalMs: 1_000_000,
        },
      }),
      12,
      (out) => out.some((m) => m._tag === "invalidate"),
    );

    const invalidate = messages.find((m) => m._tag === "invalidate");
    expect(invalidate).toBeDefined();
    expect(Number(invalidate!.invalidate.cursor.orderKey)).toBe(1004);
  });

  it("still reads forward, not backward, while catching up from far behind", async () => {
    const spans: [number, number][] = [];
    const rpc = rpcDouble({
      blocks: (tag) =>
        tag === "finalized"
          ? { number: 500, hash: "0x500", timestamp: 1_700_000_000 }
          : { number: 100_000, hash: "0xdead", timestamp: 1_700_100_000 },
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
    expect(spans[0]).toEqual([501, 1_500]);
    expect(spans[1]![0]).toBe(1_001);
    expect(spans[1]![0] - spans[0]![0]).toBeGreaterThanOrEqual(500);
  });
});

describe("poll backoff on a quiet chain", () => {
  async function pollsInWindow(options: {
    pollIntervalMs: number;
    maxPollIntervalMs: number;
    quietPollsBeforeBackoff: number;
  }): Promise<number> {
    let head = 5_000;
    const rpc = rpcDouble({
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

    expect(backedOff).toBeGreaterThan(0);
    expect(backedOff).toBeLessThanOrEqual(12);
  });

  it("keeps polling at the floor while the chain keeps producing events", async () => {
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

    expect(rpc.calls.filter((c) => c === "eth_getLogs").length).toBeGreaterThan(
      10,
    );
  });
});

describe("a measured window that changes width", () => {
  it("does not invent a reorg when the window grows", async () => {
    let poll = 0;
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
    let poll = 0;
    const reorgAt = 1_180;
    const hashFor = (n: number) =>
      (n === reorgAt && poll > 2 ? `0x${n}b` : `0x${n}a`) as Hex;

    const rpc = rpcDouble({
      blocks: (tag) => {
        if (tag === "finalized") return null;
        poll++;
        return {
          number: 1_200 + poll,
          hash: hashFor(1_200 + poll),
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
    const state = { blockRate: null, rateSample: null } as never as {
      blockRate: number | null;
      rateSample: unknown;
    };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(1_330, 1_700_000_030));
    expect(state.blockRate).toBeCloseTo(11, 5);

    observeBlockRate(state as never, head(1_330, 1_700_000_090));
    expect(state.blockRate).toBeCloseTo(11, 5);
  });

  it("a short first sample does not narrow the window below the cap", () => {
    const state = { blockRate: null, rateSample: null } as never as {
      blockRate: number | null;
      rateSample: unknown;
    };
    observeBlockRate(state as never, head(1_000, 1_700_000_000));
    observeBlockRate(state as never, head(1_005, 1_700_000_001));
    expect(state.blockRate).toBeNull();
  });
});

describe("EVM timestamp completion across a reorg", () => {
  const makeAdapter = (hash: Hex) =>
    createEvmAdapter(
      rpcDouble({
        blocks: () => ({ number: 100, hash, timestamp: 1_700_000_000 }),
        logs: () => [],
      }),
      [filter()],
      10_000,
    );
  const head = {
    number: 101,
    hash: "0x101" as Hex,
    timestamp: new Date(),
    baseFeePerGas: null,
  };

  it("refuses to attach a different fork's timestamp to logs", async () => {
    const blocks = groupLogsByBlock(
      [log({ blockHash: "0xaaa", blockTimestamp: undefined })],
      [filter()],
    );
    await expect(
      makeAdapter("0xbbb").completeFresh(blocks, head),
    ).rejects.toThrow(/changed hash/);
    expect(blocks[0]!.header.timestamp.getTime()).toBe(0);
  });

  it("uses timestamped intermediate logs without requesting their headers", async () => {
    const blocks = groupLogsByBlock([log({ blockHash: "0xaaa" })], [filter()]);
    const timestamp = blocks[0]!.header.timestamp;
    const adapter = createEvmAdapter(
      {
        request: async () => {
          throw new Error("unexpected RPC");
        },
      } as RpcLike,
      [filter()],
      10_000,
    );
    await adapter.completeFresh(blocks, head);
    expect(blocks[0]!.header.timestamp).toEqual(timestamp);
    expect(blocks[0]!.header.baseFeePerGas).toBeNull();
  });

  it("fills timestamps when the hash matches case-insensitively", async () => {
    const blocks = groupLogsByBlock(
      [log({ blockHash: "0xaaa", blockTimestamp: undefined })],
      [filter()],
    );
    await makeAdapter("0xAAA").completeFresh(blocks, head);
    expect(blocks[0]!.header.timestamp.getTime()).toBe(1_700_000_000_000);
  });
});

describe("RPC log consistency", () => {
  it("rejects duplicate positions and mixed block hashes", () => {
    expect(() => groupLogsByBlock([log(), log()], [filter()])).toThrow(
      /Duplicate/,
    );
    expect(() =>
      groupLogsByBlock(
        [log(), log({ blockHash: "0x123", logIndex: "0x2" })],
        [filter()],
      ),
    ).toThrow(/Mixed block hashes/);
  });
  it("rejects logs outside the requested range", async () => {
    const adapter = createEvmAdapter(
      rpcDouble({ logs: () => [log()] }),
      [filter()],
      10_000,
    );
    await expect(adapter.readRange(1, 2)).rejects.toThrow(
      /outside requested range/,
    );
  });
});

describe("timestamped EVM range fencing", () => {
  for (const changed of [false, true]) {
    it(
      changed
        ? "rejects a changed anchor without intermediate header reads"
        : "checks only cursor and anchor after timestamped range results",
      async () => {
        const requests: string[] = [];
        const rpc = {
          request: async ({
            method,
            params,
          }: {
            method: string;
            params: unknown[];
          }) => {
            if (method === "eth_getLogs") {
              requests.push("logs");
              return [log({ blockNumber: "0x64", blockHash: "0xaaa" })];
            }
            const number = Number(params[0]);
            requests.push(`header:${number}`);
            if (number !== 99 && number !== 101)
              throw new Error("unexpected intermediate header");
            return {
              number: numberToHex(number),
              hash: changed && number === 101 ? "0xdead" : numberToHex(number),
              timestamp: "0x6553f100",
            };
          },
        } as RpcLike;
        const adapter = createEvmAdapter(rpc, [filter()], 10_000);
        const pending = readSnapshot(
          adapter,
          {
            from: 99,
            to: 101,
            head: {
              number: 101,
              hash: "0x65",
              timestamp: new Date(1_700_000_000_000),
              baseFeePerGas: 5n,
            },
          },
          { number: 99, hash: "0x63" },
        );
        if (changed) await expect(pending).rejects.toThrow(/changed hash/);
        else {
          const result = await pending;
          expect(result.fresh).toHaveLength(1);
          expect(result.cursorChanged).toBe(false);
        }
        expect(requests).toEqual(["logs", "header:99", "header:101"]);
      },
    );
  }
});
