import { FieldElement, v1alpha2 as starknet } from "@apibara/starknet";

export function parseLong(long: number | Long): bigint {
  return BigInt(typeof long === "number" ? long : long.toNumber());
}

interface PoolKey {
  token0: string;
  token1: string;
  fee: bigint;
  tick_spacing: bigint;
  extension: string;
}

interface Bounds {
  lower: bigint;
  upper: bigint;
}

export interface PositionMintedEvent {
  token_id: bigint;
  pool_key: PoolKey;
  bounds: Bounds;
}

export interface UpdatePositionParameters {
  salt: bigint;
  bounds: Bounds;
  liquidity_delta: bigint;
}

export interface Delta {
  amount0: bigint;
  amount1: bigint;
}

export interface PositionUpdatedEvent {
  pool_key: PoolKey;
  params: UpdatePositionParameters;
  delta: Delta;
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
  [k in keyof T]: { index: number; parser: Parser<T[k]> };
}): Parser<T> {
  return (data, startingFrom) =>
    Object.entries(parsers)
      .sort(([, { index: index0 }], [, { index: index1 }]) => {
        return index0 - index1;
      })
      .reduce(
        (memo, value) => {
          const { value: parsed, next } = value[1].parser(memo.startingFrom);
          memo.value[value[0]] = parsed;
          return {
            value: parsed,
            startingFrom: next,
          };
        },
        {
          startingFrom,
          value: {},
        }
      ).value;
}

export const parseAddress: Parser<string> = (data, startingFrom) => {
  return {
    value: FieldElement.toHex(data[startingFrom]),
    next: startingFrom + 1,
  };
};

export const parsePoolKey: Parser<PoolKey> = combineParsers({
  token0: { index: 0, parser: parseAddress },
  token1: { index: 1, parser: parseAddress },
  fee: { index: 2, parser: parseU128 },
  tick_spacing: { index: 3, parser: parseI129 },
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
