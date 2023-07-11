import { PositionMintedEvent } from "./parse";

export function toNftAttributes(e: PositionMintedEvent): {
  trait_type: string;
  value: string;
}[] {
  return [
    { trait_type: "token0", value: e.pool_key.token0 },
    { trait_type: "token1", value: e.pool_key.token1 },
    { trait_type: "fee", value: e.pool_key.fee.toString() },
    { trait_type: "tick_spacing", value: e.pool_key.tick_spacing.toString() },
    { trait_type: "extension", value: e.pool_key.extension.toString() },
    { trait_type: "tick_lower", value: e.bounds.lower.toString() },
    { trait_type: "tick_upper", value: e.bounds.upper.toString() },
  ];
}
