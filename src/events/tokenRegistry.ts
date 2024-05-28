import {
  combineParsers,
  GetParserType,
  parseAddress,
  parseFelt252,
  parseU128,
  parseU8,
} from "../parse";

export const parseRegistrationEvent = combineParsers({
  address: { index: 0, parser: parseAddress },
  name: { index: 1, parser: parseFelt252 },
  symbol: { index: 2, parser: parseFelt252 },
  decimals: { index: 2, parser: parseU8 },
  total_supply: { index: 2, parser: parseU128 },
});
export type TokenRegistrationEvent = GetParserType<
  typeof parseRegistrationEvent
>;
