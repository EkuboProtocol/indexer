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
import { FieldElement } from "@apibara/starknet";
import { num, shortString } from "starknet";

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

export const parseGovernorVotedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  voter: { index: 1, parser: parseAddress },
  weight: { index: 2, parser: parseU128 },
  yea: { index: 3, parser: parseBoolean },
});
export type VotedEvent = GetParserType<typeof parseGovernorVotedEvent>;

export const parseGovernorCanceledEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  breach_timestamp: { index: 1, parser: parseU64 },
});
export type GovernorCanceledEvent = GetParserType<
  typeof parseGovernorCanceledEvent
>;

export const parseGovernorExecutedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
});
export type GovernorExecutedEvent = GetParserType<
  typeof parseGovernorExecutedEvent
>;

export const parseByteArray: Parser<string> = (data, startingFrom) => {
  const numWholeWords = Number(FieldElement.toBigInt(data[startingFrom]));
  const pendingWord = FieldElement.toBigInt(
    data[startingFrom + 1 + numWholeWords]
  );
  // not actually used
  // const pendingWordLength = data[startingFrom + 1 + numWholeWords + 1];
  const value =
    data
      .slice(startingFrom + 1, startingFrom + 1 + numWholeWords)
      .map((element) =>
        shortString.decodeShortString(num.toHex(FieldElement.toBigInt(element)))
      )
      .join("") + shortString.decodeShortString(num.toHex(pendingWord));
  return {
    next: startingFrom + 1 + numWholeWords + 1 + 1,
    value,
  };
};

export const parseDescribedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  description: { index: 1, parser: parseByteArray },
});
export type DescribedEvent = GetParserType<typeof parseDescribedEvent>;
