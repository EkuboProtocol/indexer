type WebSocketResponse = {
  id?: number;
  result?: unknown;
  error?: unknown;
};

export type StarknetWebSocketRequest = {
  id: number;
  method: string;
  params?: readonly unknown[] | Record<string, unknown>;
};

/** Send one JSON-RPC request without taking ownership of the WebSocket. */
export async function requestStarknetWebSocket(
  socket: WebSocket,
  request: StarknetWebSocketRequest,
  timeout = 10_000,
): Promise<unknown> {
  await waitForSocketOpen(socket, timeout);
  const response = await sendWebSocketRequest(socket, request, timeout);
  if (response.error !== undefined) {
    throw new Error("WebSocket JSON-RPC request failed");
  }
  return response.result;
}

function waitForSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === socket.OPEN) return Promise.resolve();
  if (socket.readyState !== socket.CONNECTING) {
    return Promise.reject(new Error("WebSocket is not open"));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket connection failed"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket timeout"));
    }, timeoutMs);
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

function sendWebSocketRequest(
  socket: WebSocket,
  request: StarknetWebSocketRequest,
  timeoutMs: number,
): Promise<WebSocketResponse> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
    };
    const listener = (event: MessageEvent) => {
      try {
        const value = JSON.parse(String(event.data)) as WebSocketResponse;
        if (value.id !== request.id) return;
        cleanup();
        resolve(value);
      } catch {
        // Ignore malformed messages that are unrelated to this request.
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket request timeout"));
    }, timeoutMs);
    socket.addEventListener("message", listener);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        method: request.method,
        params: request.params ?? [],
      }),
    );
  });
}
