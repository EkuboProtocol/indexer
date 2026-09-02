import { describe, expect, it } from "bun:test";
import { assertRpcChainIds } from "./rpcChainId";

const SEPOLIA = 11155111n;

function answering(chainId: bigint) {
  return async () => chainId;
}

function failing(message: string) {
  return async (): Promise<bigint> => {
    throw new Error(message);
  };
}

describe("assertRpcChainIds", () => {
  it("accepts a list where every transport agrees", async () => {
    await assertRpcChainIds(
      [
        { url: "a", getChainId: answering(SEPOLIA) },
        { url: "b", getChainId: answering(SEPOLIA) },
      ],
      SEPOLIA,
    );
  });

  it("tolerates a paywalled transport when another one answers", async () => {
    // The eth-sepolia outage: drpc paywalled Sepolia while 0xrpc.io stayed
    // healthy, and the all-or-nothing check crash-looped the worker anyway.
    const unreachable: string[] = [];

    await assertRpcChainIds(
      [
        {
          url: "https://sepolia.drpc.org",
          getChainId: failing("chain is not available on free plan"),
        },
        { url: "https://0xrpc.io/sep", getChainId: answering(SEPOLIA) },
      ],
      SEPOLIA,
      { onUnreachable: (url) => unreachable.push(url) },
    );

    expect(unreachable).toEqual(["https://sepolia.drpc.org"]);
  });

  it("tolerates a rate-limited transport, which is transient", async () => {
    await assertRpcChainIds(
      [
        {
          url: "https://bsc.drpc.org",
          getChainId: failing("You reached Public endpoint rate limit"),
        },
        { url: "https://working", getChainId: answering(SEPOLIA) },
      ],
      SEPOLIA,
    );
  });

  it("still rejects a transport serving a different chain", async () => {
    // The property the check exists for: a reachable endpoint pointed at the
    // wrong network would write its blocks under this indexer's chain_id.
    await expect(
      assertRpcChainIds(
        [
          { url: "https://right", getChainId: answering(SEPOLIA) },
          { url: "https://wrong", getChainId: answering(1n) },
        ],
        SEPOLIA,
      ),
    ).rejects.toThrow(/\[https:\/\/wrong=1\].*conflict.*11155111/);
  });

  it("rejects when no transport can answer at all", async () => {
    await expect(
      assertRpcChainIds(
        [
          { url: "a", getChainId: failing("down") },
          { url: "b", getChainId: failing("down") },
        ],
        SEPOLIA,
      ),
    ).rejects.toThrow(/No EVM_RPC_URL transport/);
  });
});
