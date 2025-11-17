import { combineParsers, parseAddress, parseU256 } from "./parse.js";
import type { GetParserType } from "./parse.js";

export const parseTransferEvent = combineParsers({
  from: { index: 0, parser: parseAddress },
  to: { index: 1, parser: parseAddress },
  id: { index: 2, parser: parseU256 },
});
export type TransferEvent = GetParserType<typeof parseTransferEvent>;
