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

/**
 * `EVM_RPC_URL` as an ordered list, primary first. Each entry must itself be
 * one consistent endpoint: the list is read one endpoint at a time by
 * `StickyRpc`, never spread across a single read.
 */
export function requireEvmRpcUrls(value: string | undefined): string[] {
  const entries = (value ?? "").split(",").map((entry) => entry.trim());
  if (entries.length === 1 && entries[0] === "") throw new Error("Missing EVM_RPC_URL");
  if (entries.some((entry) => entry === "")) {
    throw new Error("EVM_RPC_URL must not contain an empty entry");
  }
  const urls = entries.map((entry) => requireRpcUrl(entry, "EVM_RPC_URL"));
  if (new Set(urls).size !== urls.length) throw new Error("EVM_RPC_URL lists an endpoint twice");
  return urls;
}

export function requireStarknetRpcUrl(value: string | undefined): string {
  return requireRpcUrl(value, "STARKNET_RPC_URL");
}
