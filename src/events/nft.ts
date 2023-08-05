import {
  combineParsers,
  GetParserType,
  parseFelt252,
  parseU256,
} from "../parse";

export const parseTransferEvent = combineParsers({
  from: { index: 0, parser: parseFelt252 },
  to: { index: 1, parser: parseFelt252 },
  id: { index: 2, parser: parseU256 },
});
export type TransferEvent = GetParserType<typeof parseTransferEvent>;
