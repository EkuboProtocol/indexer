import { FieldElement, v1alpha2 as starknet } from "@apibara/starknet";

export function parseLong(long: number | Long): bigint {
  return BigInt(typeof long === "number" ? long : long.toNumber());
}

interface Parser<T> {
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

export const parseAddress: Parser<string> = (data, startingFrom) => {
  return {
    value: FieldElement.toHex(data[startingFrom]),
    next: startingFrom + 1,
  };
};

export const parsePoolKey = combineParsers({
  token0: { index: 0, parser: parseAddress },
  token1: { index: 1, parser: parseAddress },
  fee: { index: 2, parser: parseU128 },
  tick_spacing: { index: 3, parser: parseU128 },
  extension: { index: 4, parser: parseAddress },
});

export const parseBounds = combineParsers({
  lower: { index: 0, parser: parseI129 },
  upper: { index: 1, parser: parseI129 },
});

export const parsePositionMintedEvent = combineParsers({
  token_id: { index: 0, parser: parseU256 },
  pool_key: { index: 1, parser: parsePoolKey },
  parseBounds: { index: 2, parser: parseBounds },
});

const parseUpdatePositionParams = combineParsers({
  salt: { index: 0, parser: parseU128 },
  bounds: { index: 1, parser: parseBounds },
  liquidity_delta: { index: 2, parser: parseI129 },
});

export const parseDelta = combineParsers({
  amount0: { index: 0, parser: parseI129 },
  amount1: { index: 1, parser: parseI129 },
});

export const parsePositionUpdatedEvent = combineParsers({
  pool_key: { index: 0, parser: parsePoolKey },
  params: { index: 1, parser: parseUpdatePositionParams },
  delta: { index: 2, parser: parseDelta },
});

export type PoolKey = ReturnType<typeof parsePoolKey>["value"];

export type Bounds = ReturnType<typeof parseBounds>["value"];

export type PositionMintedEvent = ReturnType<
  typeof parsePositionMintedEvent
>["value"];

export type UpdatePositionParameters = ReturnType<
  typeof parseUpdatePositionParams
>["value"];

export type Delta = ReturnType<typeof parseDelta>["value"];

export type PositionUpdatedEvent = ReturnType<
  typeof parsePositionUpdatedEvent
>["value"];
