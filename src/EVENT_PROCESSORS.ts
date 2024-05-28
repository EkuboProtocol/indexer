import { EventProcessor } from "./processor";
import { FieldElement } from "@apibara/starknet";
import { logger } from "./logger";
import { parseTransferEvent, TransferEvent } from "./events/nft";
import {
  FeesAccumulatedEvent,
  parseFeesAccumulatedEvent,
  parsePoolInitializedEvent,
  parsePositionFeesCollectedEvent,
  parsePositionUpdatedEvent,
  parseProtocolFeesPaidEvent,
  parseProtocolFeesWithdrawnEvent,
  parseRegistrationEvent,
  parseSwappedEvent,
  PoolInitializationEvent,
  PositionFeesCollectedEvent,
  PositionUpdatedEvent,
  ProtocolFeesPaidEvent,
  ProtocolFeesWithdrawnEvent,
  SwappedEvent,
  TokenRegistrationEvent,
} from "./events/core";
import {
  LegacyPositionMintedEvent,
  parseLegacyPositionMintedEvent,
  parsePositionMintedWithReferrerEvent,
  PositionMintedWithReferrer,
} from "./events/positions";
import {
  OrderProceedsWithdrawnEvent,
  OrderUpdatedEvent,
  parseOrderProceedsWithdrawn,
  parseOrderUpdated,
  parseVirtualOrdersExecuted,
  VirtualOrdersExecutedEvent,
} from "./events/twamm";
import {
  parseStakedEvent,
  parseWithdrawnEvent,
  StakedEvent,
  WithdrawnEvent,
} from "./events/staker";
import {
  DescribedEvent,
  GovernorCanceledEvent,
  GovernorExecutedEvent,
  parseDescribedEvent,
  parseGovernorCanceledEvent,
  parseGovernorVotedEvent,
  parseGovernorProposedEvent,
  GovernorProposedEvent,
  GovernorVotedEvent,
  parseGovernorExecutedEvent,
  GovernorCreationThresholdBreached,
  parseGovernorCreationThresholdBreached,
} from "./events/governor";

export const EVENT_PROCESSORS = [
  <EventProcessor<LegacyPositionMintedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.POSITIONS_ADDRESS),
      keys: [
        // PositionMinted
        FieldElement.fromBigInt(
          0x2a9157ea1542bfe11220258bf15d8aa02d791e7f94426446ec85b94159929fn
        ),
      ],
    },
    parser: parseLegacyPositionMintedEvent,
    handle: async (dao, { key, parsed }) => {
      logger.debug("PositionMinted", { parsed, key });
      if (parsed.referrer !== null && parsed.referrer !== 0n) {
        await dao.insertPositionMintedWithReferrerEvent(parsed, key);
      }
    },
  },
  <EventProcessor<PositionMintedWithReferrer>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.POSITIONS_ADDRESS),
      keys: [
        // PositionMintedWithReferrer
        FieldElement.fromBigInt(
          0x0289e57bf153052470392b578fad8d64393d2b5307e0cf1bf59f7967db3480fdn
        ),
      ],
    },
    parser: parsePositionMintedWithReferrerEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("Referral", { parsed, key });
      await dao.insertPositionMintedWithReferrerEvent(parsed, key);
    },
  },
  <EventProcessor<TransferEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.NFT_ADDRESS),
      keys: [
        // Transfer
        FieldElement.fromBigInt(
          0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9n
        ),
      ],
    },
    parser: parseTransferEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("NFT transferred", { parsed, key });
      await dao.insertPositionTransferEvent(parsed, key);
    },
  },
  <EventProcessor<PositionUpdatedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // PositionUpdated
        FieldElement.fromBigInt(
          0x03a7adca3546c213ce791fabf3b04090c163e419c808c9830fb343a4a395946en
        ),
      ],
    },
    parser: parsePositionUpdatedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("PositionUpdated", { parsed, key });
      await dao.insertPositionUpdatedEvent(parsed, key);
    },
  },
  <EventProcessor<PositionFeesCollectedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // PositionFeesCollected
        FieldElement.fromBigInt(
          0x96982abd597114bdaa4a60612f87fabfcc7206aa12d61c50e7ba1e6c291100n
        ),
      ],
    },
    parser: parsePositionFeesCollectedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("PositionFeesCollected", { parsed, key });
      await dao.insertPositionFeesCollectedEvent(parsed, key);
    },
  },
  <EventProcessor<SwappedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // Swapped
        FieldElement.fromBigInt(
          0x157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870n
        ),
      ],
    },
    parser: parseSwappedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("Swapped", { parsed, key });
      await dao.insertSwappedEvent(parsed, key);
    },
  },
  <EventProcessor<PoolInitializationEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // PoolInitialized
        FieldElement.fromBigInt(
          0x025ccf80ee62b2ca9b97c76ccea317c7f450fd6efb6ed6ea56da21d7bb9da5f1n
        ),
      ],
    },
    parser: parsePoolInitializedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("PoolInitialized", { parsed, key });
      await dao.insertInitializationEvent(parsed, key);
    },
  },
  <EventProcessor<ProtocolFeesWithdrawnEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // ProtocolFeesWithdrawn
        FieldElement.fromBigInt(
          0x291697c8230383d5c3cc8dc39443356a7da6b0735605fb0ee0f7bfbb7b824an
        ),
      ],
    },
    parser: parseProtocolFeesWithdrawnEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("ProtocolFeesWithdrawn", { parsed, key });
      await dao.insertProtocolFeesWithdrawn(parsed, key);
    },
  },
  <EventProcessor<ProtocolFeesPaidEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // ProtocolFeesPaid
        FieldElement.fromBigInt(
          0x5dacf59794364ad1555bb3c9b2346afa81e57e5c19bb6bae0d22721c96c4e5n
        ),
      ],
    },
    parser: parseProtocolFeesPaidEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("ProtocolFeesPaid", { parsed, key });
      await dao.insertProtocolFeesPaid(parsed, key);
    },
  },
  <EventProcessor<FeesAccumulatedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.CORE_ADDRESS),
      keys: [
        // FeesAccumulated
        FieldElement.fromBigInt(
          0x0237e5e0677822acfc9117ed0f7ba4810b2c6b539a2359e8d73f9025d56957aan
        ),
      ],
    },
    parser: parseFeesAccumulatedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("FeesAccumulated", { parsed, key });
      await dao.insertFeesAccumulatedEvent(parsed, key);
    },
  },
  <EventProcessor<TokenRegistrationEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.TOKEN_REGISTRY_ADDRESS),
      keys: [
        // Registration
        FieldElement.fromBigInt(
          0x3ea44da5af08f985c5ac763fa2573381d77aeee47d9a845f0c6764cb805d74n
        ),
      ],
    },
    parser: parseRegistrationEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("Registration", { parsed, key });
      await dao.insertRegistration(parsed, key);
    },
  },
  <EventProcessor<TokenRegistrationEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(
        process.env.TOKEN_REGISTRY_V2_ADDRESS
      ),
      keys: [
        // Registration
        FieldElement.fromBigInt(
          0x3ea44da5af08f985c5ac763fa2573381d77aeee47d9a845f0c6764cb805d74n
        ),
      ],
    },
    parser: parseRegistrationEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("Registration V2", { parsed, key });
      await dao.insertRegistration(parsed, key);
    },
  },
  <EventProcessor<OrderUpdatedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.TWAMM_ADDRESS),
      keys: [
        // OrderUpdated
        FieldElement.fromBigInt(
          0xb670ed7b7ee8ccb350963a7dea39493daff6e7a43ab021a0e4ac2d652d359en
        ),
      ],
    },
    parser: parseOrderUpdated,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("OrderUpdated", { parsed, key });
      await dao.insertTWAMMOrderUpdatedEvent(parsed, key);
    },
  },
  <EventProcessor<OrderProceedsWithdrawnEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.TWAMM_ADDRESS),
      keys: [
        // OrderProceedsWithdrawn
        FieldElement.fromBigInt(
          0x3e074150c5906b2e323cea942b41f67f3639fcae5dc1fe4cf19c6801dff89b5n
        ),
      ],
    },
    parser: parseOrderProceedsWithdrawn,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("OrderProceedsWithdrawn", { parsed, key });
      await dao.insertTWAMMOrderProceedsWithdrawnEvent(parsed, key);
    },
  },
  <EventProcessor<VirtualOrdersExecutedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.TWAMM_ADDRESS),
      keys: [
        // VirtualOrdersExecuted
        FieldElement.fromBigInt(
          0x29416aa69fb4a5270dd3c2b3e6d05f457dc0dbf96f423db1f86c5b7b2e6840fn
        ),
      ],
    },
    parser: parseVirtualOrdersExecuted,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("VirtualOrdersExecuted", { parsed, key });
      await dao.insertTWAMMVirtualOrdersExecutedEvent(parsed, key);
    },
  },
  <EventProcessor<StakedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.STAKER_ADDRESS),
      keys: [
        // Staked
        FieldElement.fromBigInt(
          0x024fdaadc324c3bb8e59febfb2e8a399331e58193489e54ac40fec46745a9eben
        ),
      ],
    },
    parser: parseStakedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("StakerStakedEvent", { parsed, key });
      await dao.insertStakerStakedEvent(parsed, key);
    },
  },
  <EventProcessor<WithdrawnEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.STAKER_ADDRESS),
      keys: [
        // Withdrawn
        FieldElement.fromBigInt(
          0x036a4d15ab9e146faab90d4abc1c0cad17c4ded24551c781ba100392b5a70248n
        ),
      ],
    },
    parser: parseWithdrawnEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("StakerWithdrawnEvent", { parsed, key });
      await dao.insertStakerWithdrawnEvent(parsed, key);
    },
  },
  <EventProcessor<GovernorProposedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.GOVERNOR_ADDRESS),
      keys: [
        // Proposed
        FieldElement.fromBigInt(
          0x02a98c37f5b13fe14803e72b284c81be9ebbedc6cf74ed8d1489ed74951cba3fn
        ),
      ],
    },
    parser: parseGovernorProposedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("GovernorProposed", { parsed, key });
      await dao.insertGovernorProposedEvent(parsed, key);
    },
  },
  <EventProcessor<GovernorCanceledEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.GOVERNOR_ADDRESS),
      keys: [
        // Canceled
        FieldElement.fromBigInt(
          0xad1f80a0e6ac2d42f6ce99670de84817aef2368cd22a19f85fcb721f689192n
        ),
      ],
    },
    parser: parseGovernorCanceledEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("GovernorCanceled", { parsed, key });
      await dao.insertGovernorCanceledEvent(parsed, key);
    },
  },
  <EventProcessor<GovernorCreationThresholdBreached>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.GOVERNOR_ADDRESS),
      keys: [
        // CreationThresholdBreached
        FieldElement.fromBigInt(
          0xda0eb1cb71bdbfac21648d8b87024714f7eb6207978c7eb359a20144a99bafn
        ),
      ],
    },
    parser: parseGovernorCreationThresholdBreached,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("GovernorCreationThresholdBreached", { parsed, key });
      await dao.insertGovernorCreationThresholdBreachedEvent(parsed, key);
    },
  },
  <EventProcessor<GovernorVotedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.GOVERNOR_ADDRESS),
      keys: [
        // Voted
        FieldElement.fromBigInt(
          0x5c9afac1c510b50d3e0004024ba7b8e190864f1543dd8025d08f88410fb162n
        ),
      ],
    },
    parser: parseGovernorVotedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("GovernorVoted", { parsed, key });
      await dao.insertGovernorVotedEvent(parsed, key);
    },
  },
  <EventProcessor<GovernorExecutedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.GOVERNOR_ADDRESS),
      keys: [
        // Executed
        FieldElement.fromBigInt(
          0x01f4317aae43f6c24b2b85c6d8b21d5fa0a28cee0476cd52ca5d60d4787aab78n
        ),
      ],
    },
    parser: parseGovernorExecutedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("GovernorExecuted", { parsed, key });
      await dao.insertGovernorExecutedEvent(parsed, key);
    },
  },
  <EventProcessor<DescribedEvent>>{
    filter: {
      fromAddress: FieldElement.fromBigInt(process.env.GOVERNOR_ADDRESS),
      keys: [
        // Described
        FieldElement.fromBigInt(
          0x8643a1c8a461189d5b77de7576b06aa9148c9127101228f02816d13768e7a9n
        ),
      ],
    },
    parser: parseDescribedEvent,
    async handle(dao, { parsed, key }): Promise<void> {
      logger.debug("GovernorProposalDescribed", { parsed, key });
      await dao.insertGovernorProposalDescribedEvent(parsed, key);
    },
  },
] as const;
