/** Verify the sole endpoint before it can write any blocks under this chain ID. */
export async function assertRpcChainId(
  getChainId: () => Promise<bigint>,
  expectedChainId: bigint,
): Promise<void> {
  const actual = await getChainId();
  if (actual !== expectedChainId) {
    throw new Error(`EVM_RPC_URL returned chain ID ${actual}, expected ${expectedChainId}`);
  }
}
