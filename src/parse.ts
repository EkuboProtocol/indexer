import { FieldElement, v1alpha2 as starknet } from "@apibara/starknet";

export function parseLong(long: number | Long): bigint {
  return BigInt(typeof long === "number" ? long : long.toNumber());
}

export interface Parser<T> {
  (data: starknet.IFieldElement[], startingFrom: number): {
    value: T;
    next: number;
  };
}

export const parseU128: Parser<bigint> = (data, startingFrom) => {
  return {
    value: FieldElement.toBigInt(data[startingFrom]),
    next: startingFrom + 1,
  };
};

export const parseU256: Parser<bigint> = (data, startingFrom) => {
  return {
    value:
      FieldElement.toBigInt(data[startingFrom]) +
      FieldElement.toBigInt(data[startingFrom + 1]) * 2n ** 128n,
    next: startingFrom + 2,
  };
};

export const parseI129: Parser<bigint> = (data, startingFrom) => {
  return {
    value:
      FieldElement.toBigInt(data[startingFrom]) *
      (FieldElement.toBigInt(data[startingFrom + 1]) !== 0n ? -1n : 1n),
    next: startingFrom + 2,
  };
};

type GetParserType<T extends Parser<any>> = T extends Parser<infer U>
  ? U
  : never;

export function combineParsers<
  T extends {
    [key: string]: unknown;
  }
>(parsers: {
  [K in keyof T]: { index: number; parser: Parser<T[K]> };
}): Parser<T> {
  return (data, startingFrom) =>
    Object.entries(parsers)
      .sort(([, { index: index0 }], [, { index: index1 }]) => {
        return index0 - index1;
      })
      .reduce(
        (memo, fieldParser) => {
          const { value: parsedValue, next } = fieldParser[1].parser(
            data,
            memo.next
          );
          memo.value[fieldParser[0] as keyof T] = parsedValue;
          memo.next = next;
          return memo;
        },
        {
          value: {} as Partial<T>,
          next: startingFrom,
        }
      ) as {
      value: T;
      next: number;
    };
}

export const parseFelt252: Parser<bigint> = (data, startingFrom) => {
  return {
    value: FieldElement.toBigInt(data[startingFrom]),
    next: startingFrom + 1,
  };
};

export const parseBoolean: Parser<boolean> = (data, startingFrom) => {
  let num = FieldElement.toBigInt(data[startingFrom]);
  let value: boolean;
  if (num === 0n) {
    value = false;
  } else {
    if (num === 1n) {
      value = true;
    } else {
      throw new Error("Invalid boolean value");
    }
  }
  return {
    value,
    next: startingFrom + 1,
  };
};

export const parsePoolKey = combineParsers({
  token0: { index: 0, parser: parseFelt252 },
  token1: { index: 1, parser: parseFelt252 },
  fee: { index: 2, parser: parseU128 },
  tick_spacing: { index: 3, parser: parseU128 },
  extension: { index: 4, parser: parseFelt252 },
});

export type PoolKey = GetParserType<typeof parsePoolKey>;

export const parseBounds = combineParsers({
  lower: { index: 0, parser: parseI129 },
  upper: { index: 1, parser: parseI129 },
});

export type Bounds = GetParserType<typeof parseBounds>;

export const parsePositionMintedEvent = combineParsers({
  token_id: { index: 0, parser: parseU256 },
  pool_key: { index: 1, parser: parsePoolKey },
  bounds: { index: 2, parser: parseBounds },
});

export type PositionMintedEvent = GetParserType<
  typeof parsePositionMintedEvent
>;

const parseUpdatePositionParams = combineParsers({
  salt: { index: 0, parser: parseU128 },
  bounds: { index: 1, parser: parseBounds },
  liquidity_delta: { index: 2, parser: parseI129 },
});

export type UpdatePositionParameters = GetParserType<
  typeof parseUpdatePositionParams
>;

export const parseDelta = combineParsers({
  amount0: { index: 0, parser: parseI129 },
  amount1: { index: 1, parser: parseI129 },
});

export type Delta = GetParserType<typeof parseDelta>;

export const parsePositionUpdatedEvent = combineParsers({
  locker: { index: 0, parser: parseFelt252 },
  pool_key: { index: 1, parser: parsePoolKey },
  params: { index: 2, parser: parseUpdatePositionParams },
  delta: { index: 3, parser: parseDelta },
});

export type PositionUpdatedEvent = GetParserType<
  typeof parsePositionUpdatedEvent
>;

export const parsePositionKey = combineParsers({
  salt: { index: 0, parser: parseU128 },
  owner: { index: 1, parser: parseFelt252 },
  bounds: { index: 2, parser: parseBounds },
});

export const parsePositionFeesCollectedEvent = combineParsers({
  pool_key: { index: 1, parser: parsePoolKey },
  position_key: { index: 2, parser: parsePositionKey },
  delta: { index: 3, parser: parseDelta },
});

export type PositionFeesCollectedEvent = GetParserType<
  typeof parsePositionFeesCollectedEvent
>;

export const parseFeesWithdrawnEvent = combineParsers({
  recipient: { index: 0, parser: parseFelt252 },
  token: { index: 1, parser: parseFelt252 },
  amount: { index: 2, parser: parseU128 },
});

export type FeesWithdrawnEvent = GetParserType<typeof parseFeesWithdrawnEvent>;

export const parseTransferEvent = combineParsers({
  from: { index: 0, parser: parseFelt252 },
  to: { index: 1, parser: parseFelt252 },
  token_id: { index: 2, parser: parseU256 },
});

export type TransferEvent = GetParserType<typeof parseTransferEvent>;
const parseSwapParameters = combineParsers({
  amount: { index: 0, parser: parseI129 },
  is_token1: { index: 1, parser: parseBoolean },
  sqrt_ratio_limit: { index: 2, parser: parseU256 },
  skip_ahead: { index: 3, parser: parseU128 },
});

export const parseSwappedEvent = combineParsers({
  locker: { index: 0, parser: parseFelt252 },
  pool_key: { index: 1, parser: parsePoolKey },
  params: { index: 2, parser: parseSwapParameters },
  delta: { index: 3, parser: parseDelta },
  sqrt_ratio_after: { index: 4, parser: parseU256 },
  tick_after: { index: 5, parser: parseI129 },
  liquidity_after: { index: 6, parser: parseU128 },
});

export type SwappedEvent = GetParserType<typeof parseSwappedEvent>;

export const parsePoolInitializedEvent = combineParsers({
  pool_key: { index: 0, parser: parsePoolKey },
  tick: { index: 1, parser: parseI129 },
  sqrt_ratio: { index: 2, parser: parseU256 },
});

export type PoolInitializationEvent = GetParserType<
  typeof parsePoolInitializedEvent
>;

export const parseFeesPaidEvent = combineParsers({
  pool_key: { index: 0, parser: parsePoolKey },
  position_key: { index: 1, parser: parsePositionKey },
  delta: { index: 2, parser: parseDelta },
});

export type FeesPaidEvent = GetParserType<typeof parseFeesPaidEvent>;
