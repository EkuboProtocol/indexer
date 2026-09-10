/** One endpoint whose range and header reads share a consistent canonical view. */
function requireRpcUrl(value: string | undefined, name: string): string {
  const url = value?.trim();
  if (!url) throw new Error(`Missing ${name}`);
  if (url.includes(",") || /\s/.test(url)) {
    throw new Error(`${name} must contain a single HTTP(S) RPC URL, not an endpoint list`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} must contain a valid HTTP(S) RPC URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must contain an HTTP(S) RPC URL`);
  }
  return url;
}

export function requireEvmRpcUrl(value: string | undefined): string {
  return requireRpcUrl(value, "EVM_RPC_URL");
}

export function requireStarknetRpcUrl(value: string | undefined): string {
  return requireRpcUrl(value, "STARKNET_RPC_URL");
}
