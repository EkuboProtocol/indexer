export function parseEvmRpcUrls(evmRpcUrl: string | undefined): string[] {
  return (evmRpcUrl ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

export function requireStarknetRpcUrl(
  starknetRpcUrl: string | undefined,
): string {
  const trimmed = starknetRpcUrl?.trim();

  if (!trimmed) {
    throw new Error("Missing STARKNET_RPC_URL");
  }

  return trimmed;
}

export function parseOptionalUrl(url: string | undefined): string | undefined {
  return url?.trim() || undefined;
}

export function parseOptionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${trimmed}"`);
  }

  return parsed;
}
