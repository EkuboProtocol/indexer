import { describe, expect, it } from "bun:test";
import type { Hex } from "viem";
import {
  createStarknetAdapter,
  createStarknetRpc,
  eventMatchesFilter,
  groupEventsByBlock,
  matchingFilterIds,
  selectorPrefilter,
  type StarknetRpc,
  type StarknetStreamFilter,
} from "./eventStream";

/**
 * Block 14555766 of Starknet mainnet, reduced to the shape this reads.
 *
 * Not invented. The chain really answers with 28 events for its first
 * transaction and 8 for its second, with ours at indices 3 and 19 of the first
 * and 1 of the second -- and the production database really holds
 * (tx 0, event 3), (tx 0, event 19) and (tx 1, event 1) for it, written years
 * ago by the DNA stream this replaces. Reproducing those three pairs from the
 * RPC is the whole reason the receipts read exists.
 */
const BLOCK_NUMBER = 14_555_766;
const BLOCK_TIMESTAMP = 1_788_870_514;
// Unpadded, exactly as the node returns it. The config below is padded.
const BLOCK_HASH =
  "0xe2e6b27298293e43981bc78a466ed6c4435cda64fceb1b849a151581e942a7" as Hex;
const TX0 =
  "0x14e1987a79e7343af32021e4644ffe7e6229a6c3a852761344a9fb331750544" as Hex;
const TX1 =
  "0x21ffe2bf674418f0804f98316027146bfc6378aff0dffce43dc06d0a6cc7032" as Hex;
/** As `.env.starknet.mainnet` writes it: zero-padded, and mixed case. */
const CORE_PADDED =
  "0x00000005dd3D2F4429AF886cD1a3b08289DBcEa99A294197E9eB43b0e0325b4b" as Hex;
/** As the node returns it. */
const CORE_UNPADDED =
  "0x5dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b" as Hex;
const SWAPPED =
  "0x157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870" as Hex;
const OTHER_CONTRACT = "0x1234" as Hex;

const coreFilter: StarknetStreamFilter = {
  id: 1,
  fromAddress: CORE_PADDED,
  keys: [SWAPPED],
};

function emitted(over: Partial<Record<string, unknown>> = {}) {
  return {
    from_address: CORE_UNPADDED,
    keys: [SWAPPED],
    data: ["0x1"] as Hex[],
    block_hash: BLOCK_HASH,
    block_number: BLOCK_NUMBER,
    transaction_hash: TX0,
    transaction_index: 0,
    event_index: 3,
    ...over,
  } as Parameters<typeof groupEventsByBlock>[0][number];
}

/** A block header, as `starknet_getBlockWithTxHashes` answers. */
function header(over: Record<string, unknown> = {}) {
  return {
    block_hash: BLOCK_HASH,
    block_number: BLOCK_NUMBER,
    timestamp: BLOCK_TIMESTAMP,
    ...over,
  };
}

function rpcReturning(handlers: Record<string, unknown[]>): {
  rpc: StarknetRpc;
  calls: { method: string; params: unknown }[];
} {
  const calls: { method: string; params: unknown }[] = [];
  const remaining = Object.fromEntries(
    Object.entries(handlers).map(([method, responses]) => [
      method,
      [...responses],
    ]),
  );
  return {
    calls,
    rpc: {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params });
        const queue = remaining[method];
        if (!queue || queue.length === 0) {
          throw new Error(`unexpected call to ${method}`);
        }
        return (queue.length === 1 ? queue[0] : queue.shift()) as T;
      },
    },
  };
}

describe("eventMatchesFilter", () => {
  it("compares felts by value, not by string", () => {
    // The single most likely way to break Starknet indexing: the node writes a
    // felt unpadded, the env writes it padded, and a string compare silently
    // matches nothing at all while looking perfectly healthy.
    expect(
      eventMatchesFilter(
        { address: CORE_UNPADDED, keys: [SWAPPED] },
        coreFilter,
      ),
    ).toBe(true);
  });

  it("matches a key written with and without leading zeroes", () => {
    expect(
      eventMatchesFilter(
        { address: CORE_UNPADDED, keys: [`0x0${SWAPPED.slice(2)}` as Hex] },
        coreFilter,
      ),
    ).toBe(true);
  });

  it("rejects another contract emitting the same selector", () => {
    expect(
      eventMatchesFilter(
        { address: OTHER_CONTRACT, keys: [SWAPPED] },
        coreFilter,
      ),
    ).toBe(false);
  });

  it("matches on a prefix, so extra keys do not disqualify an event", () => {
    expect(
      eventMatchesFilter(
        { address: CORE_UNPADDED, keys: [SWAPPED, "0x9" as Hex] },
        coreFilter,
      ),
    ).toBe(true);
  });

  it("rejects an event carrying fewer keys than the filter names", () => {
    expect(
      eventMatchesFilter({ address: CORE_UNPADDED, keys: [] }, coreFilter),
    ).toBe(false);
  });
});

describe("selectorPrefilter", () => {
  it("dedupes selectors that differ only in padding", () => {
    const selectors = selectorPrefilter([
      coreFilter,
      { id: 2, fromAddress: OTHER_CONTRACT, keys: [`0x0${SWAPPED.slice(2)}`] },
    ]);
    expect(selectors).toHaveLength(1);
  });

  it("is disabled entirely by a filter that matches on address alone", () => {
    // A prefilter has to be a superset of what the local matcher accepts. A
    // filter with no selector cannot be represented as one, so narrowing the
    // read would silently drop that processor's events.
    expect(
      selectorPrefilter([coreFilter, { id: 2, fromAddress: CORE_PADDED, keys: [] }]),
    ).toBeNull();
  });
});

describe("groupEventsByBlock", () => {
  it("keeps only matched events and sorts blocks ascending", () => {
    const blocks = groupEventsByBlock(
      [
        emitted({ block_number: BLOCK_NUMBER + 1 }),
        emitted({ from_address: OTHER_CONTRACT }),
        emitted(),
      ],
      [coreFilter],
    );
    expect(blocks.map((b) => Number(b.header.blockNumber))).toEqual([
      BLOCK_NUMBER,
      BLOCK_NUMBER + 1,
    ]);
    expect(blocks[0]!.logs).toHaveLength(1);
  });

  it("omits a block carrying nothing we match", () => {
    // Load-bearing for the shared diff: a block with no matched event has no
    // representation in a range read, so recording one would make it look like
    // it had vanished on the next re-read.
    expect(
      groupEventsByBlock([emitted({ from_address: OTHER_CONTRACT })], [
        coreFilter,
      ]),
    ).toEqual([]);
  });

  it("skips a pre-confirmed event, which has no hash to anchor a cursor to", () => {
    expect(
      groupEventsByBlock(
        [emitted({ block_hash: undefined, block_number: undefined })],
        [coreFilter],
      ),
    ).toEqual([]);
  });
});

describe("groupEventsByBlock positions", () => {
  it("carries through the transaction and event indices the database holds", () => {
    // Block 14555766's three Core events. The production database holds
    // (0, 3), (0, 19) and (1, 1) for them, written by the DNA stream; v0.10
    // reports the same, and so did a reconstruction from the block's receipts.
    const blocks = groupEventsByBlock(
      [
        emitted({ transaction_hash: TX0, transaction_index: 0, event_index: 3 }),
        emitted({ transaction_hash: TX0, transaction_index: 0, event_index: 19 }),
        emitted({ transaction_hash: TX1, transaction_index: 1, event_index: 1 }),
      ],
      [coreFilter],
    );

    expect(
      blocks[0]!.logs.map((e) => [e.transactionIndex, e.eventIndex]),
    ).toEqual([
      [0, 3],
      [0, 19],
      [1, 1],
    ]);
  });

  it("refuses an event with no position rather than defaulting it to zero", () => {
    // A zero here is not a near miss: it is a wrong `event_id`, which is a
    // primary key other tables order on, written with no error anywhere. An
    // endpoint answering without these is serving a spec older than v0.10.
    expect(() =>
      groupEventsByBlock(
        [emitted({ transaction_index: undefined, event_index: undefined })],
        [coreFilter],
      ),
    ).toThrow(/v0\.10/);
  });

  it("refuses an event index compute_event_id cannot represent", () => {
    expect(() =>
      groupEventsByBlock([emitted({ event_index: 65_536 })], [coreFilter]),
    ).toThrow(/compute_event_id/);
  });
});

describe("completeFresh", () => {
  it("takes the block timestamp from the header read", async () => {
    const { rpc } = rpcReturning({ starknet_getBlockWithTxHashes: [header()] });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });
    const blocks = groupEventsByBlock([emitted()], [coreFilter]);

    expect(blocks[0]!.header.timestamp.getTime()).toBe(0);
    await adapter.completeFresh(blocks, {
      number: BLOCK_NUMBER + 5,
      hash: "0xff",
      timestamp: new Date(),
      baseFeePerGas: null,
    });
    expect(blocks[0]!.header.timestamp.getTime()).toBe(BLOCK_TIMESTAMP * 1000);
  });

  it("never changes how many events a block holds", async () => {
    // The shared diff compares the count recorded when a block was emitted
    // against the count the next range read reports. A completion step that
    // added or dropped one would manufacture a reorg on every single poll.
    const { rpc } = rpcReturning({ starknet_getBlockWithTxHashes: [header()] });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });
    const blocks = groupEventsByBlock(
      [emitted(), emitted({ event_index: 19 })],
      [coreFilter],
    );

    await adapter.completeFresh(blocks, {
      number: BLOCK_NUMBER,
      hash: BLOCK_HASH,
      timestamp: new Date(),
      baseFeePerGas: null,
    });
    expect(blocks[0]!.logs).toHaveLength(2);
  });

  it("refuses a block that changed hash between the two reads", async () => {
    // Two requests, so the chain can move between them. A timestamp from a
    // different block would reach `blocks.block_time` with nothing to flag it.
    const { rpc } = rpcReturning({
      starknet_getBlockWithTxHashes: [header({ block_hash: "0xdead" })],
    });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });
    const blocks = groupEventsByBlock([emitted()], [coreFilter]);

    await expect(
      adapter.completeFresh(blocks, {
        number: BLOCK_NUMBER,
        hash: BLOCK_HASH,
        timestamp: new Date(),
        baseFeePerGas: null,
      }),
    ).rejects.toThrow(/changed hash/);
  });

  it("stamps the head's gas price onto the head block only", async () => {
    const { rpc } = rpcReturning({ starknet_getBlockWithTxHashes: [header()] });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });
    const blocks = groupEventsByBlock([emitted()], [coreFilter]);

    await adapter.completeFresh(blocks, {
      number: BLOCK_NUMBER,
      hash: BLOCK_HASH,
      timestamp: new Date(),
      baseFeePerGas: 28_776_978_417n,
    });
    expect(blocks[0]!.header.baseFeePerGas).toBe(28_776_978_417n);
  });

  it("reads once per block, not once per event", async () => {
    const { rpc, calls } = rpcReturning({
      starknet_getBlockWithTxHashes: [header()],
    });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });
    const blocks = groupEventsByBlock(
      [emitted(), emitted({ event_index: 19 }), emitted({ event_index: 21 })],
      [coreFilter],
    );

    await adapter.completeFresh(blocks, {
      number: BLOCK_NUMBER,
      hash: BLOCK_HASH,
      timestamp: new Date(),
      baseFeePerGas: null,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("readRange", () => {
  it("follows the continuation token to the end", async () => {
    const { rpc, calls } = rpcReturning({
      starknet_getEvents: [
        { events: [emitted()], continuation_token: "14555766-1" },
        { events: [emitted({ transaction_hash: TX1 })] },
      ],
    });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });

    const blocks = await adapter.readRange(BLOCK_NUMBER, BLOCK_NUMBER);
    expect(blocks[0]!.logs).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(
      (calls[1]!.params as [{ continuation_token: string }])[0]
        .continuation_token,
    ).toBe("14555766-1");
  });

  it("sends the selector prefilter rather than asking per address", async () => {
    // One address per request would be twelve requests a poll where EVM makes
    // one, which is the whole cost argument for this shape.
    const { rpc, calls } = rpcReturning({
      starknet_getEvents: [{ events: [] }],
    });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });

    await adapter.readRange(1, 10);
    const params = (calls[0]!.params as [Record<string, unknown>])[0];
    expect(params.keys).toEqual([[SWAPPED]]);
    expect(params.address).toBeUndefined();
  });

  it("refuses a range that will not finish paginating", async () => {
    const { rpc } = rpcReturning({
      starknet_getEvents: [{ events: [], continuation_token: "forever" }],
    });
    const adapter = createStarknetAdapter({
      rpc,
      filters: [coreFilter],
      maxPages: 3,
    });

    await expect(adapter.readRange(1, 1_000)).rejects.toThrow(
      /did not finish paginating/,
    );
  });
});

describe("fetchHead", () => {
  it("reads the L2 gas price the cursor stores as its base fee", async () => {
    const { rpc } = rpcReturning({
      starknet_getBlockWithTxHashes: [
        {
          block_hash: BLOCK_HASH,
          block_number: BLOCK_NUMBER,
          timestamp: BLOCK_TIMESTAMP,
          l2_gas_price: { price_in_fri: "0x6b33dd7f1" },
        },
      ],
    });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });

    expect(await adapter.fetchHead()).toEqual({
      number: BLOCK_NUMBER,
      // Padded to 32 bytes on the way out; the node sends 62 hex characters.
      hash: `0x00${BLOCK_HASH.slice(2)}`,
      timestamp: new Date(BLOCK_TIMESTAMP * 1000),
      baseFeePerGas: 28_776_978_417n,
    });
  });

  it("asks for l1_accepted as the finalized block", async () => {
    // Starknet finality is settlement on Ethereum. `latest` is ACCEPTED_ON_L2,
    // which can still be reorged.
    const { rpc, calls } = rpcReturning({
      starknet_getBlockWithTxHashes: [
        { block_hash: BLOCK_HASH, block_number: 1, timestamp: 1 },
      ],
    });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });

    await adapter.fetchFinalized();
    expect(calls[0]!.params).toEqual(["l1_accepted"]);
  });

  it("treats a block with no hash as unreadable rather than as a cursor", async () => {
    const { rpc } = rpcReturning({
      starknet_getBlockWithTxHashes: [{ timestamp: 1 }],
    });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });
    expect(await adapter.fetchHead()).toBeNull();
  });
});

describe("matchingFilterIds", () => {
  it("returns every filter an event satisfies", () => {
    expect(
      matchingFilterIds({ address: CORE_UNPADDED, keys: [SWAPPED] }, [
        coreFilter,
        { id: 2, fromAddress: CORE_PADDED, keys: [] },
        { id: 3, fromAddress: OTHER_CONTRACT, keys: [SWAPPED] },
      ]),
    ).toEqual([1, 2]);
  });
});

describe("canonical block hashes", () => {
  // The adapter compares felts by value, but the shared core cannot:
  // `firstDivergentBlock` diffs hash strings and `headUnchanged` compares them
  // outright. A node that strips leading zeroes on one request and not the next
  // would read as a block that changed hash -- a reorg that never happened,
  // with rows deleted and re-indexed for it.
  const PADDED = `0x${"0".repeat(2)}${BLOCK_HASH.slice(2)}` as Hex;

  it("pads a block hash carried on an event", () => {
    const [short] = groupEventsByBlock([emitted()], [coreFilter]);
    const [long] = groupEventsByBlock(
      [emitted({ block_hash: PADDED })],
      [coreFilter],
    );
    expect(short!.header.blockHash).toBe(long!.header.blockHash);
    expect(short!.header.blockHash).toHaveLength(66);
  });

  it("pads a block hash carried on a header", async () => {
    const { rpc } = rpcReturning({
      starknet_getBlockWithTxHashes: [header(), header({ block_hash: PADDED })],
    });
    const adapter = createStarknetAdapter({ rpc, filters: [coreFilter] });
    const first = await adapter.fetchHead();
    const second = await adapter.fetchHead();
    expect(first!.hash).toBe(second!.hash);
    expect(first!.hash).toHaveLength(66);
  });

  it("still matches the cursor it is compared against numerically", () => {
    const [block] = groupEventsByBlock([emitted()], [coreFilter]);
    expect(BigInt(block!.header.blockHash)).toBe(BigInt(BLOCK_HASH));
  });
});

describe("createStarknetRpc", () => {
  const withFetch = async <T>(
    responses: (() => Response)[],
    run: (rpc: ReturnType<typeof createStarknetRpc>) => Promise<T>,
  ): Promise<{ result: T | Error; calls: number }> => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      const next = responses[Math.min(calls++, responses.length - 1)]!;
      return next();
    }) as unknown as typeof fetch;
    try {
      return { result: await run(createStarknetRpc("https://x", { retryDelayMs: 1 })), calls };
    } catch (error) {
      return { result: error as Error, calls };
    } finally {
      globalThis.fetch = original;
    }
  };

  const json = (body: unknown, status = 200) =>
    () => new Response(JSON.stringify(body), { status });

  it("retries a compute-unit overage, which arrives as HTTP 200 code 429", async () => {
    // The trap: Alchemy reports an overage as a *successful* HTTP response
    // carrying a JSON-RPC error. Throwing here would exit the generator and
    // restart.sh would poll the throttling endpoint a second later, forever.
    const { result, calls } = await withFetch(
      [
        json({ error: { code: 429, message: "capacity" } }),
        json({ result: { block_number: 7 } }),
      ],
      (rpc) => rpc.request("starknet_blockNumber", []),
    );
    expect(result).toEqual({ block_number: 7 });
    expect(calls).toBe(2);
  });

  it("does not retry an error that is an answer", async () => {
    const { result, calls } = await withFetch(
      [json({ error: { code: -32602, message: "Invalid params" } })],
      (rpc) => rpc.request("starknet_getEvents", []),
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/Invalid params/);
    expect(calls).toBe(1);
  });

  it("retries a transient HTTP status", async () => {
    const { result, calls } = await withFetch(
      [json({}, 503), json({ result: 1 })],
      (rpc) => rpc.request("starknet_blockNumber", []),
    );
    expect(result).toBe(1);
    expect(calls).toBe(2);
  });
});
