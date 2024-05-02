import {
  combineParsers,
  GetParserType,
  parseAddress,
  parseBoolean,
  parseFelt252,
  Parser,
  parseSpanOf,
  parseU128,
  parseU64,
} from "../parse";

export const parseCall = combineParsers({
  to: { index: 0, parser: parseAddress },
  selector: { index: 1, parser: parseFelt252 },
  calldata: { index: 2, parser: parseSpanOf(parseFelt252) },
});
export type CallType = GetParserType<typeof parseCall>;

export const parseProposedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  proposer: { index: 1, parser: parseAddress },
  call: { index: 2, parser: parseCall },
});
export type ProposedEvent = GetParserType<typeof parseProposedEvent>;

export const parseVotedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  voter: { index: 1, parser: parseAddress },
  weight: { index: 2, parser: parseU128 },
  yea: { index: 3, parser: parseBoolean },
});
export type VotedEvent = GetParserType<typeof parseVotedEvent>;

export const parseCanceledEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  breach_timestamp: { index: 1, parser: parseU64 },
});
export type CanceledEvent = GetParserType<typeof parseCanceledEvent>;

export const parseExecutedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
});
export type ExecutedEvent = GetParserType<typeof parseExecutedEvent>;

export const parseByteArrayString: Parser<string> = (data, startingFrom) => {
  throw new Error("todo");
};

export const parseDescribedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  description: { index: 1, parser: parseByteArrayString },
});
export type DescribedEvent = GetParserType<typeof parseDescribedEvent>;
