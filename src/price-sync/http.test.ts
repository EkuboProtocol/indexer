import { afterEach, expect, test } from "bun:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { PriceSyncError } from "./errors";
import { fetchJson, REQUEST_TIMEOUT } from "./http";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((input: string | URL, init: RequestInit = {}) => {
    seen.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof globalThis.fetch;
  return seen;
}

const request = <T,>() =>
  fetchJson<T>({
    source: "tst",
    operation: "fetch prices",
    url: "https://prices.example/v1",
    headers: { "x-api-key": "secret" },
  });

// Runs a request expected to fail, resolving with the typed error. `flip`
// rather than a catch so an unexpected success fails the test instead of
// widening the assertion to `unknown`.
const failure = (): Promise<PriceSyncError> =>
  Effect.runPromise(Effect.flip(request<unknown>()));

test("a 200 response is decoded", async () => {
  const seen = stubFetch(async () =>
    new Response(JSON.stringify({ price: 3_000 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  const result = await Effect.runPromise(request<{ price: number }>());

  expect(result).toEqual({ price: 3_000 });
  expect(seen[0].url).toBe("https://prices.example/v1");
  expect((seen[0].init.headers as Record<string, string>)["x-api-key"]).toBe(
    "secret",
  );
});

test("a non-2xx response carries the status and body into the error", async () => {
  stubFetch(async () => new Response("upstream is down", { status: 503 }));

  const error = await failure();

  expect(error).toBeInstanceOf(PriceSyncError);
  expect(error.message).toContain("503");
  expect(error.message).toContain("upstream is down");
  // The job and the step both name themselves, so a log line is actionable
  // without the caller having to add context at every call site.
  expect(error.message).toContain("tst");
  expect(error.message).toContain("fetch prices");
});

test("a transport failure becomes a typed error rather than a rejection", async () => {
  stubFetch(async () => {
    throw new Error("getaddrinfo ENOTFOUND prices.example");
  });

  const error = await failure();

  expect(error).toBeInstanceOf(PriceSyncError);
  expect(error.message).toContain("ENOTFOUND");
});

test("a response that never arrives times out and aborts the request", async () => {
  // Nothing under the previous `fetch` calls had a deadline, and a job runs one
  // cycle at a time, so a connection that never answered stalled that source
  // for the life of the process.
  let signal: AbortSignal | undefined;
  stubFetch(
    (_url, init) =>
      new Promise<Response>(() => {
        signal = init.signal ?? undefined;
      }),
  );

  const program = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.flip(request<unknown>()));
    yield* TestClock.adjust(Duration.millis(Duration.toMillis(REQUEST_TIMEOUT) + 1));
    return yield* Fiber.join(fiber);
  });

  const error = await Effect.runPromise(
    Effect.provide(program, TestClock.layer()),
  );

  expect(error).toBeInstanceOf(PriceSyncError);
  expect(error.message).toContain("timed out");
  // Not merely abandoned: the socket is closed rather than left to drain.
  expect(signal?.aborted).toBe(true);
});
