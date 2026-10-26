import { describe, expect, it } from "bun:test";
import type { Address, Hex } from "viem";
import { numberToHex } from "viem";
import type { DiscoveredAddressSource } from "../_shared/dao";
import {
  createEvmAdapter,
  groupLogsByBlock,
  MAX_ADDRESSES_PER_GET_LOGS,
  type LogStreamFilter,
  type RawLog,
  type RpcLike,
} from "./logStream";

const FACTORY: Address = "0x5100000000000000000000000000000000000000";
const TOKEN: Address = "0x838047be0779c59e69610451ccf3fd71f5fb4a53";
const OTHER_TOKEN: Address = "0x000000000000000000000000000000000000ffff";
const CREATED: Hex = `0x${"0a".repeat(32)}`;
const TRANSFER: Hex = `0x${"dd".repeat(32)}`;
const APPROVAL: Hex = `0x${"8c".repeat(32)}`;
const word = (address: Address): Hex =>
  `0x${address.slice(2).padStart(64, "0")}`;

const SOURCE: DiscoveredAddressSource = {
  kind: "zero_seed_launch_token",
  address: FACTORY,
  topic0: CREATED,
  topicIndex: 2,
};
const FILTERS: LogStreamFilter[] = [
  { id: 1, address: FACTORY, topics: [CREATED], strict: false },
  {
    id: 2,
    address: FACTORY,
    topics: [TRANSFER],
    strict: false,
    discoveredBy: SOURCE,
  },
  {
    id: 3,
    address: FACTORY,
    topics: [APPROVAL],
    strict: false,
    discoveredBy: SOURCE,
  },
];

function log(
  block: number,
  logIndex: number,
  address: Address,
  topics: Hex[],
): RawLog {
  return {
    address,
    topics,
    data: "0x",
    blockHash: numberToHex(block, { size: 32 }),
    blockNumber: numberToHex(block),
    blockTimestamp: numberToHex(1_700_000_000 + block),
    transactionHash: numberToHex(block * 100 + 1, { size: 32 }),
    transactionIndex: "0x0",
    logIndex: numberToHex(logIndex),
  };
}

/** The creation transaction: two mints, then the event naming the token. */
const CHAIN: RawLog[] = [
  log(10, 0, TOKEN, [TRANSFER, word("0x0"), word(FACTORY)]),
  log(10, 1, TOKEN, [TRANSFER, word("0x0"), word("0x0")]),
  log(10, 2, FACTORY, [CREATED, `0x${"01".repeat(32)}`, word(TOKEN)]),
  log(11, 0, TOKEN, [APPROVAL, word(FACTORY), word(FACTORY)]),
  log(12, 0, TOKEN, [TRANSFER, word(FACTORY), word(OTHER_TOKEN)]),
  log(12, 1, OTHER_TOKEN, [TRANSFER, word("0x0"), word(FACTORY)]),
];

/** eth_getLogs over CHAIN, filtered by range and address like a node. */
function chainRpc(logs: RawLog[] = CHAIN) {
  const calls: { from: number; to: number; addresses: string[] }[] = [];
  const rpc: RpcLike = {
    request: (async ({
      method,
      params,
    }: {
      method: string;
      params: [{ fromBlock: Hex; toBlock: Hex; address: Address[] }];
    }) => {
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const [{ fromBlock, toBlock, address }] = params;
      const addresses = address.map((a) => a.toLowerCase());
      calls.push({ from: Number(fromBlock), to: Number(toBlock), addresses });
      return logs.filter(
        (l) =>
          Number(l.blockNumber) >= Number(fromBlock) &&
          Number(l.blockNumber) <= Number(toBlock) &&
          addresses.includes(l.address.toLowerCase()),
      );
    }) as RpcLike["request"],
  };
  return { rpc, calls };
}

const matched = (blocks: ReturnType<typeof groupLogsByBlock>) =>
  blocks.flatMap((b) =>
    b.logs.map((l) => [Number(b.header.blockNumber), l.logIndex, l.filterIds]),
  );

describe("filters following discovered addresses", () => {
  it("match a contract's logs that precede, in the same transaction, the event naming it", () => {
    expect(matched(groupLogsByBlock(CHAIN.slice(0, 4), FILTERS))).toEqual([
      [10, 0, [2]],
      [10, 1, [2]],
      [10, 2, [1]],
      [11, 0, [3]],
    ]);
    // without the naming event, the same logs match nothing
    expect(groupLogsByBlock([CHAIN[0], CHAIN[3]], FILTERS)).toEqual([]);
  });

  it("re-read a range from the block that names a new address, then follow it in one read", async () => {
    const { rpc, calls } = chainRpc();
    const adapter = createEvmAdapter(rpc, FILTERS, 10_000, async () => []);
    expect(matched(await adapter.readRange(10, 11))).toEqual([
      [10, 0, [2]],
      [10, 1, [2]],
      [10, 2, [1]],
      [11, 0, [3]],
    ]);
    expect(calls).toEqual([
      { from: 10, to: 11, addresses: [FACTORY.toLowerCase()] },
      { from: 10, to: 11, addresses: [TOKEN] },
    ]);
    calls.length = 0;
    // an address not named by the source is never read
    expect(matched(await adapter.readRange(12, 12))).toEqual([[12, 0, [2]]]);
    expect(calls).toEqual([
      { from: 12, to: 12, addresses: [FACTORY.toLowerCase(), TOKEN] },
    ]);
  });

  it("is consistent across re-reads of a window, whichever read discovered the address", async () => {
    const { rpc } = chainRpc();
    const adapter = createEvmAdapter(rpc, FILTERS, 10_000, async () => []);
    const first = matched(await adapter.readRange(10, 12));
    expect(first).toHaveLength(5);
    expect(matched(await adapter.readRange(10, 12))).toEqual(first);
    expect(matched(await adapter.readRange(11, 12))).toEqual(first.slice(3));
  });

  it("loads the indexed addresses once, before the first read", async () => {
    const { rpc, calls } = chainRpc();
    const loads: DiscoveredAddressSource[] = [];
    const adapter = createEvmAdapter(rpc, FILTERS, 10_000, async (source) => {
      loads.push(source);
      return [TOKEN.toUpperCase().replace("0X", "0x") as Address];
    });
    expect(matched(await adapter.readRange(11, 12))).toEqual([
      [11, 0, [3]],
      [12, 0, [2]],
    ]);
    await adapter.readRange(11, 12);
    expect(loads).toEqual([SOURCE]);
    expect(calls).toHaveLength(2);
  });

  it("refuse to read without a loader for the indexed addresses", async () => {
    const adapter = createEvmAdapter(chainRpc().rpc, FILTERS, 10_000);
    await (expect(adapter.readRange(10, 11)).rejects.toThrow(
      /no loadDiscoveredAddresses/,
    ) as unknown as Promise<void>);
  });

  it("leave a stream without them unchanged: one read, no loader", async () => {
    const { rpc, calls } = chainRpc();
    const adapter = createEvmAdapter(rpc, FILTERS.slice(0, 1), 10_000);
    expect(matched(await adapter.readRange(10, 12))).toEqual([[10, 2, [1]]]);
    expect(calls).toHaveLength(1);
  });

  it("split a long address list into bounded requests", async () => {
    const { rpc, calls } = chainRpc();
    const many = Array.from(
      { length: MAX_ADDRESSES_PER_GET_LOGS + 5 },
      (_, i): Address => `0x${(i + 1).toString(16).padStart(40, "0")}`,
    );
    const adapter = createEvmAdapter(rpc, FILTERS, 10_000, async () => [
      ...many,
      TOKEN,
    ]);
    expect(matched(await adapter.readRange(12, 12))).toEqual([[12, 0, [2]]]);
    expect(calls.map((c) => c.addresses.length)).toEqual([
      MAX_ADDRESSES_PER_GET_LOGS,
      7,
    ]);
  });
});
