export function parseEvmRpcUrls(evmRpcUrl: string | undefined): string[] {
  return (evmRpcUrl ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
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
