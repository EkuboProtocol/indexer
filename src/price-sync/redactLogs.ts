import { format } from "node:util";
import { redactSecrets } from "../_shared/redactSecrets";

/**
 * Keeps this worker's secrets out of its stdout and stderr (EKU-521).
 *
 * The Alchemy key sits in the path of every `rpcUrls` entry of
 * `CHAINLINK_TOKEN_PRICE_CONFIG`, and viem copies the whole endpoint URL into
 * every `HttpRequestError` message. Those messages reach the logs through
 * Effect's default logger (a failed cycle, a failed feed discovery) and through
 * the `console.warn` for a single failed feed. The indexer's winston logger
 * redacts its own lines (indexer#221); this worker never used it.
 *
 * Effect's default logger writes through `globalThis.console`, looked up on
 * every call, so wrapping the console's methods covers it and the direct
 * `console.warn` alike. Each call is formatted to its final string first, so a
 * key is caught wherever it sits: the message, an error's stack or `cause`, or
 * an annotation.
 */
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

// A key shorter than this would be replaced inside ordinary words.
const MIN_SECRET_LENGTH = 8;

function chainlinkRpcUrls(rawConfig: string | undefined): string[] {
  if (!rawConfig) return [];
  try {
    const chains: unknown = JSON.parse(rawConfig);
    if (typeof chains !== "object" || chains === null) return [];
    return Object.values(chains).flatMap((chain: unknown) => {
      const urls = (chain as { rpcUrls?: unknown } | null)?.rpcUrls;
      return Array.isArray(urls)
        ? urls.filter((url): url is string => typeof url === "string" && url.length > 0)
        : [];
    });
  } catch {
    // An unparseable config fails startup; the key patterns still apply.
    return [];
  }
}

function redactedUrl(url: string): string {
  try {
    return `${new URL(url).origin}/<redacted>`;
  } catch {
    return "<redacted rpc url>";
  }
}

export function redactPriceSyncLog(
  text: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const replacements: [string, string][] = chainlinkRpcUrls(
    env.CHAINLINK_TOKEN_PRICE_CONFIG,
  ).map((url) => [url, redactedUrl(url)]);
  const coingeckoKey = env.COINGECKO_API_KEY?.trim();
  if (coingeckoKey && coingeckoKey.length >= MIN_SECRET_LENGTH) {
    replacements.push([coingeckoKey, "<redacted>"]);
  }

  let out = text;
  // Longest first, so a secret that prefixes another cannot leave a tail behind.
  for (const [secret, replacement] of replacements.sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    out = out.split(secret).join(replacement);
  }
  return redactSecrets(out, env);
}

/**
 * Routes every console method through the redaction. Returns a function that
 * restores the originals, for tests.
 */
export function installLogRedaction(
  target: Console = globalThis.console,
  env: Record<string, string | undefined> = process.env,
): () => void {
  const originals = CONSOLE_METHODS.map((method) => [method, target[method]] as const);
  for (const [method, original] of originals) {
    target[method] = (...args: unknown[]) =>
      original.call(target, redactPriceSyncLog(format(...args), env));
  }
  return () => {
    for (const [method, original] of originals) target[method] = original;
  };
}
