// Guards against a misconfigured EVM_RPC_URL writing another chain's blocks
// under this indexer's chain_id.
//
// Once an indexer has a cursor the stream catches this on its own: the stored
// cursor carries a block hash, and a stream serving a different chain rejects
// it as not canonical. That protection does not exist on a fresh start, where
// there is no stored hash to check against, so the chain ID is asserted up
// front instead.
//
// The distinction that matters is between a transport that disagrees and one
// that cannot answer. dRPC's public endpoints return "chain is not available
// on free plan" and "You reached Public endpoint rate limit"; neither says
// anything about which chain the endpoint serves. Treating those as fatal is
// what left eth-sepolia crash-looping from 2026-07-31, with a healthy fallback
// URL configured the whole time. So an unreachable transport is reported and
// skipped, and only an answer that conflicts is fatal.
export interface ChainIdProbe {
  url: string;
  getChainId: () => Promise<bigint>;
}

export async function assertRpcChainIds(
  probes: ChainIdProbe[],
  expectedChainId: bigint,
  {
    onUnreachable,
  }: { onUnreachable?: (url: string, error: unknown) => void } = {},
): Promise<void> {
  const results = await Promise.allSettled(
    probes.map(async ({ url, getChainId }) => ({
      url,
      chainId: await getChainId(),
    })),
  );

  const answered: { url: string; chainId: bigint }[] = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      answered.push(result.value);
    } else {
      onUnreachable?.(probes[index]!.url, result.reason);
    }
  });

  if (answered.length === 0) {
    throw new Error(
      `No EVM_RPC_URL transport could report a chain ID for chain ID ${expectedChainId}`,
    );
  }

  const conflicting = answered.filter(
    ({ chainId }) => chainId !== expectedChainId,
  );

  if (conflicting.length > 0) {
    const details = conflicting
      .map(({ url, chainId }) => `${url}=${chainId}`)
      .join(", ");

    throw new Error(
      `EVM_RPC_URL transports return chain IDs [${details}] which conflict with environment chain ID ${expectedChainId}`,
    );
  }
}
