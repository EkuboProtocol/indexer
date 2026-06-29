export function requireEvmRpcUrl(evmRpcUrl: string | undefined): string {
  const trimmed = evmRpcUrl?.trim();

  if (!trimmed) {
    throw new Error("Missing EVM_RPC_URL");
  }

  return trimmed;
}

export function requireStarknetApibaraUrl(
  apibaraUrl: string | undefined,
): string {
  const trimmed = apibaraUrl?.trim();

  if (!trimmed) {
    throw new Error("Missing APIBARA_URL");
  }

  return trimmed;
}
