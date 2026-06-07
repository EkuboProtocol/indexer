import { Metadata, createClient } from "@apibara/protocol";
import { Block as StarknetBlock, StarknetStream } from "@apibara/starknet";
import type { EventKey } from "../_shared/eventKey";
import { logger } from "../_shared/logger";
import { loadHexAddresses } from "../_shared/loadHexAddresses";
import { requireStarknetApibaraUrl } from "../_shared/streamEndpoints";
import { runIndexer } from "../runtime";
import { createEventProcessors } from "../starknet/eventProcessors";
import type { NetworkEntrypoint, StreamOptions } from "./types";

export function isStarknetBlock(block: unknown): block is StarknetBlock {
  return Boolean(block && typeof block === "object" && "events" in block);
}

export function createStarknetEntrypoint(): NetworkEntrypoint<StarknetBlock> {
  const starknetAddressConfig = loadHexAddresses({
    nftAddress: "NFT_ADDRESS",
    coreAddress: "CORE_ADDRESS",
    tokenRegistryAddress: "TOKEN_REGISTRY_ADDRESS",
    tokenRegistryV2Address: "TOKEN_REGISTRY_V2_ADDRESS",
    tokenRegistryV3Address: "TOKEN_REGISTRY_V3_ADDRESS",
    twammAddress: "TWAMM_ADDRESS",
    stakerAddress: "STAKER_ADDRESS",
    governorAddress: "GOVERNOR_ADDRESS",
    oracleAddress: "ORACLE_ADDRESS",
    limitOrdersAddress: "LIMIT_ORDERS_ADDRESS",
    splineLiquidityProviderAddress: "SPLINE_LIQUIDITY_PROVIDER_ADDRESS",
  });

  if (!starknetAddressConfig) {
    throw new Error("Missing or invalid Starknet contract addresses");
  }

  logger.info(`Indexing Starknet contracts`, { starknetAddressConfig });

  const processors = createEventProcessors(starknetAddressConfig);
  const starknetApibaraUrl = requireStarknetApibaraUrl(process.env.APIBARA_URL);

  return {
    createStream(streamOptions: StreamOptions) {
      return createClient(StarknetStream, starknetApibaraUrl, {
        defaultCallOptions: {
          "*": {
            metadata: Metadata({
              Authorization: "Bearer " + process.env.DNA_TOKEN,
            }),
          },
        },
      }).streamData({
        ...streamOptions,
        filter: [
          {
            events: processors.map((processor, ix) => ({
              id: ix + 1,
              address: processor.filter.fromAddress,
              keys: processor.filter.keys,
            })),
          },
        ],
      });
    },
    getPlannedEvents(block: StarknetBlock) {
      return block.events.reduce(
        (total, event) => total + (event.filterIds?.length ?? 0),
        0,
      );
    },
    async processBlock({ block, blockNumber, dao }) {
      let eventsProcessed = 0;

      for (const event of block.events) {
        const eventKey: EventKey = {
          blockNumber,
          transactionIndex: event.transactionIndex,
          eventIndex: event.eventIndexInTransaction ?? event.eventIndex,
          emitter: event.address,
          transactionHash: event.transactionHash,
        };

        await Promise.all(
          event.filterIds.map(async (matchingFilterId: number) => {
            eventsProcessed++;
            const processor = processors[matchingFilterId - 1]!;
            const { value: parsed } = processor.parser(event.data, 0);
            await processor.handle(dao, { key: eventKey, parsed });
          }),
        );
      }

      return eventsProcessed;
    },
  };
}

if (import.meta.main) {
  await runIndexer({
    networkType: "starknet",
    createEntrypoint: () => createStarknetEntrypoint(),
    isBlock: isStarknetBlock,
  });
}
