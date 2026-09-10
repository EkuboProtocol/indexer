import { expect, it } from "bun:test";
import { assertRpcChainId } from "./rpcChainId";

it("accepts the configured chain", async () => {
  await assertRpcChainId(async () => 4663n, 4663n);
});
it("rejects the wrong chain before indexing", async () => {
  await expect(assertRpcChainId(async () => 1n, 4663n)).rejects.toThrow(/chain ID 1, expected 4663/);
});
it("propagates an unavailable endpoint instead of indexing without verification", async () => {
  await expect(assertRpcChainId(async () => { throw new Error("unavailable"); }, 4663n)).rejects.toThrow("unavailable");
});
