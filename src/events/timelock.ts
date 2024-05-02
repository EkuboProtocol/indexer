import {
  combineParsers,
  GetParserType,
  parseFelt252,
  parseSpanOf,
} from "../parse";
import { parseCall } from "./governor";

export const parseQueuedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  calls: { index: 1, parser: parseSpanOf(parseCall) },
});
export type QueuedEvent = GetParserType<typeof parseQueuedEvent>;

export const parseCanceledEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
});
export type CanceledEvent = GetParserType<typeof parseCanceledEvent>;

export const parseExecutedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
});
export type ExecutedEvent = GetParserType<typeof parseExecutedEvent>;
