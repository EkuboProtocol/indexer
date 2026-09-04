import { Duration, Effect } from "effect";
import { PriceSyncError } from "./errors";

// Every upstream request gets a deadline. Nothing under the previous `fetch`
// calls had one, and a job runs one cycle at a time, so a connection that
// never answered stalled that source indefinitely -- silently, because the
// loop was still "in progress". Generous enough that a slow but working
// upstream still completes.
export const REQUEST_TIMEOUT = Duration.seconds(30);

interface JsonRequest {
  // Names the failing job in the log line, e.g. "cg1".
  readonly source: string;
  // Names the step, e.g. "token prices for chain 8453".
  readonly operation: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly referrer?: string;
  readonly timeout?: Duration.Duration;
}

function readBody(response: Response): Effect.Effect<string> {
  return Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => ""));
}

/**
 * GET a JSON document, with the request tied to the fiber.
 *
 * `Effect.tryPromise` hands the callback an `AbortSignal`, so interrupting
 * this effect -- on timeout, or when the process is shutting down -- actually
 * cancels the in-flight request rather than leaving it running with nobody
 * waiting on it.
 */
export function fetchJson<T>({
  source,
  operation,
  url,
  headers,
  referrer,
  timeout = REQUEST_TIMEOUT,
}: JsonRequest): Effect.Effect<T, PriceSyncError> {
  const fail = (cause: unknown) =>
    new PriceSyncError({ source, operation, cause });

  return Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        method: "GET",
        credentials: "omit",
        headers: { Accept: "application/json", ...headers },
        ...(referrer === undefined ? {} : { referrer }),
        signal,
      }),
    catch: fail,
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({
            try: () => response.json() as Promise<T>,
            catch: fail,
          })
        : readBody(response).pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                fail(
                  new Error(
                    `${response.status} ${response.statusText}: ${body}`,
                  ),
                ),
              ),
            ),
          ),
    ),
    Effect.timeout(timeout),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        fail(new Error(`timed out after ${Duration.toMillis(timeout)}ms`)),
      ),
    ),
  );
}
