import { Effect, Schema } from "effect";

export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

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
