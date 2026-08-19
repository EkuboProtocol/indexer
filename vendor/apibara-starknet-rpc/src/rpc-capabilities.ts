import { type SemVer, gte, parse } from "semver";
import { StarknetJsonRpcClient, type StarknetRpcClientOptions } from "./client";

export type StarknetRpcSubscriptionCapabilities = {
  newHeads: boolean;
  newTransactions: boolean;
  transactionStatus: boolean;
  events: boolean;
};

const PROBE_CLIENT_OPTIONS = {
  requestsPerSecond: 10,
  maxConcurrency: 4,
  retryCount: 2,
} as const;

type ProbeOptions = Pick<
  StarknetRpcClientOptions,
  "timeout" | "retryCount" | "retryDelay" | "fetch" | "headers"
>;

/** Capabilities defined by the reported Starknet JSON-RPC specification. */
export class StarknetRpcCapabilities {
  readonly blockWithReceipts: boolean;
  readonly stateUpdates: boolean;
  readonly traces: boolean;
  readonly subscriptions: StarknetRpcSubscriptionCapabilities;
  readonly multiAddressEvents: boolean;
  readonly stateAddressFiltering: boolean;

  private constructor(readonly specVersion: string) {
    const version = parseSpecVersion(specVersion);
    const rpc08 = gte(version, "0.8.0");
    const rpc09 = gte(version, "0.9.0");
    const rpc0101 = gte(version, "0.10.1");

    this.blockWithReceipts = rpc08;
    this.stateUpdates = rpc08;
    this.traces = rpc08;
    this.subscriptions = {
      newHeads: rpc08,
      newTransactions: rpc09,
      transactionStatus: rpc08,
      events: rpc08,
    };
    this.multiAddressEvents = rpc0101;
    this.stateAddressFiltering = rpc0101;
  }

  /**
   * Read the endpoint's reported specification version and derive standardized
   * RPC features without probing each method individually.
   */
  static async probe(
    url: string,
    options: ProbeOptions = {},
  ): Promise<StarknetRpcCapabilities> {
    const client = new StarknetJsonRpcClient(url, {
      ...PROBE_CLIENT_OPTIONS,
      ...options,
    });
    const specVersion = await client.request<string>("starknet_specVersion");
    return new StarknetRpcCapabilities(specVersion);
  }

  /** Derive standardized features from a previously fetched spec version. */
  static fromSpecVersion(specVersion: string): StarknetRpcCapabilities {
    return new StarknetRpcCapabilities(specVersion);
  }
}

export function parseSpecVersion(version: string): SemVer {
  const parsed = parse(version);
  if (!parsed) {
    throw new Error(`Invalid starknet_specVersion response: ${version}`);
  }
  return parsed;
}
