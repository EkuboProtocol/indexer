import { Parser } from "./parse";
import { DAO } from "./dao";

export interface EventKey {
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  fromAddress: bigint;
  transactionHash: bigint;
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
    keys: `0x${string}`[];
    fromAddress: `0x${string}`;
  };

  parser: Parser<T>;

  handle(dao: DAO, result: ParsedEventWithKey<T>): Promise<void>;
}
