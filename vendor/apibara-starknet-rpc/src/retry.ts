import { sleep } from "@apibara/protocol/rpc";

export type RetryOptions = {
  retryCount: number;
  retryDelay: number | ((error: unknown) => number);
  shouldRetry: (error: unknown) => boolean;
  onRetry?: (error: unknown) => void;
};

/** Retry a request with a fixed, configurable delay between attempts. */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempt = async (remainingRetries: number): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (remainingRetries === 0 || !options.shouldRetry(error)) throw error;

      options.onRetry?.(error);
      const delay =
        typeof options.retryDelay === "function"
          ? options.retryDelay(error)
          : options.retryDelay;
      if (delay > 0) await sleep(delay);
      return attempt(remainingRetries - 1);
    }
  };

  return attempt(options.retryCount);
}
