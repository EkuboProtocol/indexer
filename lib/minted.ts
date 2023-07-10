import { FieldElement, v1alpha2 as starknet } from "@apibara/starknet";

interface PoolKey {
  token0: string;
  token1: string;
  fee: bigint;
  tick_spacing: number;
  extension: bigint;
}

interface Bounds {
  tick_lower: number;
  tick_upper: number;
}

interface PositionMintedEvent {
  token_id: bigint;
  pool_key: PoolKey;
  bounds: Bounds;
}

export function parsePositionMintedEvent(ev: starknet.IEventWithTransaction) {
  return {
    token_id: BigInt(FieldElement.toHex(ev.event.data[0])),
    pool_key: {
      token0: FieldElement.toHex(ev.event.data[2]),
      token1: FieldElement.toHex(ev.event.data[3]),
      fee: BigInt(FieldElement.toHex(ev.event.data[4])),
      tick_spacing: Number(FieldElement.toHex(ev.event.data[5])),
      extension: BigInt(FieldElement.toHex(ev.event.data[6])),
    },
    bounds: {
      tick_lower:
        Number(FieldElement.toHex(ev.event.data[7])) *
        (Number(FieldElement.toHex(ev.event.data[8])) === 0 ? 1 : -1),
      tick_upper:
        Number(FieldElement.toHex(ev.event.data[9])) *
        (Number(FieldElement.toHex(ev.event.data[10])) === 0 ? 1 : -1),
    },
  };
}

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
    { trait_type: "tick_lower", value: e.bounds.tick_lower.toString() },
    { trait_type: "tick_upper", value: e.bounds.tick_upper.toString() },
  ];
}
