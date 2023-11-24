import { FieldElement, v1alpha2 as starknet } from "@apibara/starknet";

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

export const parseU64 = parseU128;

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

export type GetParserType<T extends Parser<any>> = T extends Parser<infer U>
  ? U
  : never;

export const parseU8: Parser<number> = (data, startingFrom) => {
  return {
    value: Number(FieldElement.toBigInt(data[startingFrom])),
    next: startingFrom + 1,
  };
};

export const parseFelt252: Parser<bigint> = (data, startingFrom) => {
  return {
    value: FieldElement.toBigInt(data[startingFrom]),
    next: startingFrom + 1,
  };
};

export const parseAddress: Parser<bigint> = parseFelt252;

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

/**
 * Returns a parser that will only run if there is additional data in the event to be parsed
 * @param parser the parser that it will run if there is additional data
 */
export function backwardsCompatibleParserAdditionalArgument<T>(
  parser: Parser<T>
): Parser<T | null> {
  return (data, startingFrom) => {
    if (startingFrom < data.length) {
      return parser(data, startingFrom);
    }
    return { value: null, next: startingFrom };
  };
}

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
