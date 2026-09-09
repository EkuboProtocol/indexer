export type RpcEnvelope<T> = { result?: T; error?: { code: number; message: string } };

/** A successful HTTP response is not necessarily a successful JSON-RPC answer. */
export function parseRpcEnvelope<T>(value: unknown): RpcEnvelope<T> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid JSON-RPC envelope");
  }
  const body = value as Record<string, unknown>;
  if (body.jsonrpc !== "2.0" || body.id !== 1) {
    throw new Error("JSON-RPC response version or ID does not match the request");
  }
  const hasResult = Object.hasOwn(body, "result");
  const hasError = Object.hasOwn(body, "error");
  if (hasResult === hasError) throw new Error("JSON-RPC response must contain exactly one result or error");
  if (hasError) requireRpcError(body.error);
  return body as RpcEnvelope<T>;
}

function requireRpcError(error: unknown): void {
  if (error === null || typeof error !== "object") throw new Error("Invalid JSON-RPC error");
  const body = error as Record<string, unknown>;
  if (!Number.isInteger(body.code) || typeof body.message !== "string") {
    throw new Error("Invalid JSON-RPC error code or message");
  }
}
