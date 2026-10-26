import type { LoadStoredBlocks } from "./_shared/blockStream";
import type {
  DAO,
  DiscoveredAddressSource,
  IndexerCursor,
} from "./_shared/dao";

export type NetworkType = "evm" | "starknet";

export function isNetworkTypeValid(
  networkType: string | undefined,
): networkType is NetworkType {
  return Boolean(networkType && ["starknet", "evm"].includes(networkType));
}

export interface StreamOptions {
  finality: "accepted";
  startingCursor: IndexerCursor;
  loadPreviousCursor?: (before: number) => Promise<IndexerCursor | null>;
  loadStoredBlocks?: LoadStoredBlocks;
  /** Contracts an EVM stream already follows (see LogStreamFilter.discoveredBy). */
  loadDiscoveredAddresses?: (
    source: DiscoveredAddressSource,
  ) => Promise<`0x${string}`[]>;
  heartbeatInterval: {
    seconds: bigint;
    nanos: number;
  };
}

export interface NetworkEntrypoint<TBlock> {
  createStream(streamOptions: StreamOptions): AsyncIterable<any>;
  getPlannedEvents(block: TBlock): number;
  processBlock(params: {
    block: TBlock;
    blockNumber: number;
    dao: DAO;
  }): Promise<number>;
}
