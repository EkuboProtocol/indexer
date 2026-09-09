import type { IndexerCursor } from "./dao";
import type { StreamMessage } from "./blockStream";

/** Switch RPCs only by restarting a stream at its last acknowledged cursor. */
export async function* withRpcFailover<T>(
  sources: ((cursor: IndexerCursor) => AsyncIterable<StreamMessage<T>>)[],
  startingCursor: IndexerCursor,
  onFailure: (index: number, error: unknown) => void,
): AsyncGenerator<StreamMessage<T>> {
  let cursor = startingCursor;
  for (let i = 0; i < sources.length; i++) {
    try {
      for await (const message of sources[i]!(cursor)) {
        if (message._tag === "data") cursor = message.data.endCursor;
        if (message._tag === "invalidate") cursor = message.invalidate.cursor;
        yield message;
      }
      return;
    } catch (error) {
      onFailure(i, error);
      if (i === sources.length - 1) throw error;
    }
  }
  throw new Error("No verified RPC sources available");
}
