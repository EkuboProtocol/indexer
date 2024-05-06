import {
  combineParsers,
  GetParserType,
  parseAddress,
  parseBoolean,
  parseFelt252,
  parseSpanOf,
  parseU128,
  parseU64,
} from "../parse";
import { parseByteArray } from "./core";

export const parseCall = combineParsers({
  to: { index: 0, parser: parseAddress },
  selector: { index: 1, parser: parseFelt252 },
  calldata: { index: 2, parser: parseSpanOf(parseFelt252) },
});
export type CallType = GetParserType<typeof parseCall>;

export const parseGovernorProposedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  proposer: { index: 1, parser: parseAddress },
  calls: { index: 2, parser: parseSpanOf(parseCall) },
});
export type GovernorProposedEvent = GetParserType<
  typeof parseGovernorProposedEvent
>;

export const parseGovernorVotedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  voter: { index: 1, parser: parseAddress },
  weight: { index: 2, parser: parseU128 },
  yea: { index: 3, parser: parseBoolean },
});
export type GovernorVotedEvent = GetParserType<typeof parseGovernorVotedEvent>;

export const parseGovernorCanceledEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  breach_timestamp: { index: 1, parser: parseU64 },
});
export type GovernorCanceledEvent = GetParserType<
  typeof parseGovernorCanceledEvent
>;

export const parseGovernorExecutedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  result_data: { index: 1, parser: parseSpanOf(parseSpanOf(parseFelt252)) },
});
export type GovernorExecutedEvent = GetParserType<
  typeof parseGovernorExecutedEvent
>;

export const parseDescribedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  description: { index: 1, parser: parseByteArray },
});
export type DescribedEvent = GetParserType<typeof parseDescribedEvent>;
