import { StarknetJsonRpcClient, type StarknetRpcClientOptions } from "./client";
import { requestStarknetWebSocket } from "./websocket-request";

const PROBE_CLIENT_OPTIONS = {
  requestsPerSecond: 10,
  maxConcurrency: 4,
  retryCount: 2,
} as const;

type ProbeOptions = Pick<
  StarknetRpcClientOptions,
  "timeout" | "retryCount" | "retryDelay" | "fetch" | "headers"
>;

/** Capabilities that can vary between deployments of the same RPC version. */
export class StarknetEndpointCapabilities {
  private constructor(
    /** Whether the endpoint accepts JSON-RPC batch request arrays. */
    readonly batch: boolean,
    /** Whether the supplied WebSocket URL serves Starknet JSON-RPC. */
    readonly webSocket: boolean,
  ) {}

  /** Probe only deployment properties that are not guaranteed by RPC version. */
  static async probe(
    url: string,
    wsUrl?: string,
    options: ProbeOptions = {},
  ): Promise<StarknetEndpointCapabilities> {
    const [batch, webSocket] = await Promise.all([
      probeBatch(url, options),
      wsUrl
        ? probeWebSocketTransport(wsUrl, options.timeout)
        : Promise.resolve(false),
    ]);
    return new StarknetEndpointCapabilities(batch, webSocket);
  }
}

async function probeBatch(
  url: string,
  options: ProbeOptions,
): Promise<boolean> {
  try {
    const client = new StarknetJsonRpcClient(url, {
      ...PROBE_CLIENT_OPTIONS,
      batch: true,
      ...options,
    });
    const result = await client.batch<[string, string]>([
      { method: "starknet_specVersion" },
      { method: "starknet_chainId" },
    ]);
    return (
      result.length === 2 && result.every((item) => typeof item === "string")
    );
  } catch {
    return false;
  }
}

async function probeWebSocketTransport(
  wsUrl: string,
  timeout?: number,
): Promise<boolean> {
  let socket: WebSocket | undefined;
  try {
    if (!URL.canParse(wsUrl) || typeof WebSocket === "undefined") return false;
    socket = new WebSocket(wsUrl);
    const specVersion = await requestStarknetWebSocket(
      socket,
      { id: 1, method: "starknet_specVersion" },
      timeout,
    );
    return typeof specVersion === "string";
  } catch {
    return false;
  } finally {
    socket?.close();
  }
}
