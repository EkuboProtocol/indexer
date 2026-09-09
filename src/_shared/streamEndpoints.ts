export function parseEvmRpcUrls(evmRpcUrl: string | undefined): string[] {
  return (evmRpcUrl ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

/**
 * One URL, not a list.
 *
 * The EVM side takes a comma-separated list for historical reasons and switches only between complete stream attempts, because two endpoints can serve two
 * different views of the same chain and a stream that alternates between them
 * reorgs against itself. Starknet never had the list, so it does not get one.
 */
export function requireStarknetRpcUrl(rpcUrl: string | undefined): string {
  const trimmed = rpcUrl?.trim();

  if (!trimmed) {
    throw new Error("Missing STARKNET_RPC_URL");
  }

  return trimmed;
}
