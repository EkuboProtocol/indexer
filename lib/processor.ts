import { v1alpha2 as starknet } from "@apibara/starknet";

export interface BlockMeta {
  blockNumber: number;
  blockTimestamp: Date;
  isFinal: boolean;
}

export interface EventProcessor<T> {
  filter: {
    keys: starknet.IFieldElement[];
    fromAddress: starknet.IFieldElement;
  };

  parser(ev: starknet.IEventWithTransaction): T;

  handle(ev: T, meta: BlockMeta): Promise<void>;
}
