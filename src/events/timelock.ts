import {
  combineParsers,
  GetParserType,
  parseFelt252,
  parseSpanOf,
} from "../parse";
import { parseCall } from "./governor";

export const parseTimelockQueuedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
  calls: { index: 1, parser: parseSpanOf(parseCall) },
});
export type TimelockQueuedEvent = GetParserType<
  typeof parseTimelockQueuedEvent
>;

export const parseTimelockCanceledEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
});
export type TimelockCanceledEvent = GetParserType<
  typeof parseTimelockCanceledEvent
>;

export const parseTimelockExecutedEvent = combineParsers({
  id: { index: 0, parser: parseFelt252 },
});
export type TimelockExecutedEvent = GetParserType<
  typeof parseTimelockExecutedEvent
>;
