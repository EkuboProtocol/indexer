import { Effect, Schema } from "effect";

/** Human-readable text for an unknown thrown value. */
export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The one failure a price sync job can produce.
 *
 * Every fetcher talks to something that throws `unknown` -- `fetch`, viem, the
 * postgres driver -- so each of those boundaries is converted here instead of
 * letting untyped rejections travel up. `source` and `operation` are what the
 * supervisor logs, so a failing cycle names the job and the step without the
 * caller having to reconstruct either.
 */
export class PriceSyncError extends Schema.TaggedError<PriceSyncError>()(
  "PriceSyncError",
  {
    source: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.source}: ${this.operation}: ${describeCause(this.cause)}`;
  }
}

/**
 * Runs a promise-returning operation, converting a rejection into a
 * `PriceSyncError`.
 *
 * The `postgres` driver and viem both stay promise-based -- swapping either
 * for an Effect-native binding would be a far larger change than this one --
 * so this is the single place their rejections become typed failures.
 */
export function tryPriceSync<A>({
  source,
  operation,
  try: run,
}: {
  readonly source: string;
  readonly operation: string;
  readonly try: (signal: AbortSignal) => PromiseLike<A>;
}): Effect.Effect<A, PriceSyncError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new PriceSyncError({ source, operation, cause }),
  });
}
