import { Duration, Effect } from "effect";
import { PriceSyncError } from "./errors";

// Every upstream request gets a deadline. Nothing under the previous `fetch`
// calls had one, and a job runs one cycle at a time, so a connection that
// never answered stalled that source indefinitely -- silently, because the
// loop was still "in progress". Generous enough that a slow but working
// upstream still completes.
export const REQUEST_TIMEOUT = Duration.seconds(30);

interface JsonRequest {
  readonly source: string;
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
