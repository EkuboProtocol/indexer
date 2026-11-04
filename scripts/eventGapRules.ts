/**
 * The failed-check error of the event-gap monitor (`monitorEventGaps.ts`), kept
 * free of I/O so it can be tested.
 *
 * When an audit exits without a summary, the alert's `error` is all a triager
 * has, so it carries the audit's own exception. The audit logs through the
 * indexer's winston logger: an uncaught exception arrives as a JSON `error`
 * line on stdout, after a long address-config line, while stderr holds dotenv
 * banners. Bun prints its own report on stderr only for what fails before the
 * logger loads, such as a missing package, and nothing is logged when the
 * monitor kills a slow audit. So the error is the last logged error when there
 * is one, and otherwise the output that can explain the failure, stderr last.
 * A long error keeps its start, where the exception names itself, and its end.
 *
 * Monitor RPC URLs carry provider keys, and the webhook body is stored as the
 * routine run's payload. The text is redacted before it is shortened, so a cut
 * cannot strand part of a key. Each configured RPC URL and the PG connection
 * string is replaced whole, as configured and as `URL` normalizes it, and each
 * of their key-shaped parts on its own, in case a provider echoes the request
 * path. The shared patterns and a userinfo rule then catch credentials in any
 * other URL.
 */
import { redactSecrets } from "../src/_shared/redactSecrets";

export const ERROR_MAX_LENGTH = 1_000;
export const SUMMARY_ERROR_MAX_LENGTH = 240;

/** Output lines that never explain a failure. */
const NOISE = [
  /injected env \(\d+\)/, // dotenv's banner
  /^at /, // a stack frame
  /^\d+ \| /, // Bun's source excerpt
  /^\^+$/, // and its caret
  /^Bun v\d/, // Bun's version trailer
];
const ERROR_LEVEL = new Set(["error"]);
const EXPLAINING_LEVELS = new Set(["error", "warn"]);

/**
 * At least 16 word characters with a digit or a capital, like a provider key
 * and unlike a lowercase path word such as `arbitrum-mainnet`.
 */
const KEY_SHAPED = /^(?=.*[\dA-Z])[\w-]{16,}$/;
const MIN_SECRET_LENGTH = 8;
const USERINFO = /\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#@"'\\<>]+@/gi;

type LogEntry = { level?: unknown; message?: unknown; kind?: unknown };

function jsonObject(line: string): LogEntry | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

function loggedMessage(entry: LogEntry | undefined, levels: Set<string>) {
  return typeof entry?.level === "string" &&
    levels.has(entry.level) &&
    typeof entry.message === "string"
    ? entry.message
    : undefined;
}

/**
 * What one output line says about a failure: a logged warning's or error's
 * message, any other line that is neither noise nor a log or report entry.
 */
function explanation(line: string): string[] {
  const entry = jsonObject(line);
  if (entry === undefined) return NOISE.some((p) => p.test(line)) ? [] : [line];
  if (entry.level !== undefined) {
    return loggedMessage(entry, EXPLAINING_LEVELS)?.split("\n") ?? [];
  }
  return typeof entry.kind === "string" ? [] : [line];
}

/** The audit's own account of why it stopped, unredacted. */
export function failureText(stdout: string, stderr: string): string {
  const lines = `${stdout}\n${stderr}`.split("\n").map((line) => line.trim());
  const logged = lines
    .map((line) => loggedMessage(jsonObject(line), ERROR_LEVEL))
    .findLast((message) => message !== undefined);
  return (logged?.split("\n") ?? lines.flatMap(explanation))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

/** Keeps the start and the end of a text longer than `max`. */
export function elide(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  return `${text.slice(0, head)} … ${text.slice(text.length - (max - head - 3))}`;
}

/** A URL as configured and as `URL` prints it, and its parts that can be keys. */
function urlForms(raw: string): { whole: string[]; parts: string[] } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { whole: [raw], parts: [] };
  }
  const keyShaped = [
    ...url.pathname.split("/"),
    ...url.searchParams.values(),
  ].filter((part) => KEY_SHAPED.test(part));
  return { whole: [raw, url.href], parts: [url.password, ...keyShaped] };
}

export type MonitorSecrets = { rpcUrls: string[]; pgConnectionString?: string };

export function createRedactor({
  rpcUrls,
  pgConnectionString,
}: MonitorSecrets): (text: string) => string {
  const replacements = new Map<string, string>();
  const add = (raw: string, placeholder: string) => {
    const { whole, parts } = urlForms(raw);
    for (const form of whole) replacements.set(form, placeholder);
    for (const part of parts) replacements.set(part, "<redacted>");
  };
  for (const url of rpcUrls) add(url, "<redacted rpc url>");
  if (pgConnectionString) {
    add(pgConnectionString, "<redacted pg connection string>");
  }
  // Longest first, so a URL is replaced whole before any part of it.
  const ordered = [...replacements]
    .filter(([secret]) => secret.length >= MIN_SECRET_LENGTH)
    .sort(([a], [b]) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const [secret, placeholder] of ordered) {
      out = out.split(secret).join(placeholder);
    }
    return redactSecrets(out, {}).replace(USERINFO, "$1<redacted>@");
  };
}

/**
 * The `error` of a check whose audit produced no summary. `outcome` is how the
 * audit ended: its exit code, or the monitor's timeout.
 */
export function checkError(
  outcome: string,
  stdout: string,
  stderr: string,
  redact: (text: string) => string,
): string {
  const text = redact(failureText(stdout, stderr)) || "no output";
  return `${outcome}, no summary: ${elide(text, ERROR_MAX_LENGTH)}`;
}
