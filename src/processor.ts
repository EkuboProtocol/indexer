import { v1alpha2 as starknet } from "@apibara/starknet";
import { Parser } from "./parse";
import { DAO } from "./dao";

export interface EventKey {
  blockNumber: number;
  transactionHash: bigint;
  transactionIndex: number;
  eventIndex: number;
}

export function eventKeyToId(key: EventKey): bigint {
  return (
    (BigInt(key.blockNumber) << 32n) +
    (BigInt(key.transactionIndex) << 16n) +
    BigInt(key.eventIndex)
  );
}

export interface ParsedEventWithKey<T> {
  key: EventKey;
  parsed: T;
}

export interface EventProcessor<T> {
  filter: {
    keys: starknet.IFieldElement[];
    fromAddress: starknet.IFieldElement;
  };

  parser: Parser<T>;

  handle(dao: DAO, result: ParsedEventWithKey<T>): Promise<void>;
}
