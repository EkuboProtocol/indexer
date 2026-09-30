/**
 * Strips RPC credentials from text bound for the logs.
 *
 * Provider keys live in the endpoint URL -- Alchemy's in the path
 * (`/v2/<key>`, `/rpc/v0_10/<key>`), dRPC's in the query (`dkey=`) -- and viem
 * puts the whole URL into every `HttpRequestError` message (its `getUrl` only
 * strips basic-auth credentials). Any log line carrying such an error, which is
 * every "provider read failed; backing off" warning, would otherwise print the
 * key (EKU-516).
 *
 * The configured endpoint URLs are replaced exactly, keeping the origin so a
 * log still says which provider failed; the patterns catch a key in a URL that
 * was never configured here, such as one quoted inside a provider's own error.
 */
const CONFIGURED_URL_VARS = ["EVM_RPC_URL", "STARKNET_RPC_URL"] as const;

const KEY_PATTERNS: [RegExp, string][] = [
  // Alchemy EVM (`/v2/<key>`) and Starknet (`/rpc/v0_10/<key>`) paths.
  [/(\/v\d+\/)[A-Za-z0-9_-]{20,}/g, "$1<redacted>"],
  [/(\/rpc\/v\d+_\d+\/)[A-Za-z0-9_-]{20,}/g, "$1<redacted>"],
  // Query-string keys: dRPC `dkey`, and the common `key` / `apikey` / `api_key`.
  [/([?&](?:dkey|key|apikey|api_key|api-key|token)=)[^&\s"'\\]+/gi, "$1<redacted>"],
];

function configuredUrls(env: Record<string, string | undefined>): string[] {
  return CONFIGURED_URL_VARS.flatMap((name) =>
    (env[name] ?? "").split(",").map((url) => url.trim()).filter((url) => url.length > 0),
  );
}

function redactedForm(url: string): string {
  try {
    return `${new URL(url).origin}/<redacted>`;
  } catch {
    return "<redacted rpc url>";
  }
}

export function redactSecrets(
  text: string,
  env: Record<string, string | undefined> = process.env,
): string {
  let out = text;
  // Longest first, so a URL that prefixes another cannot leave a tail behind.
  for (const url of configuredUrls(env).sort((a, b) => b.length - a.length)) {
    out = out.split(url).join(redactedForm(url));
  }
  for (const [pattern, replacement] of KEY_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
