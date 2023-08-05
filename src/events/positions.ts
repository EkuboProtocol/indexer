import { parseBounds, parsePoolKey } from "./core";
import { combineParsers, GetParserType, parseU64 } from "../parse";

export const parsePositionMintedEvent = combineParsers({
  id: { index: 0, parser: parseU64 },
  pool_key: { index: 1, parser: parsePoolKey },
  bounds: { index: 2, parser: parseBounds },
});
export type PositionMintedEvent = GetParserType<
  typeof parsePositionMintedEvent
>;
