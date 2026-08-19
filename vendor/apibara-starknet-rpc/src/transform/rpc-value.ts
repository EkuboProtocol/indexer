/**
 * Converts loosely typed JSON-RPC fields into the strict scalar and collection
 * shapes used by the internal Starknet model.
 */
import type { RpcObject } from "../rpc-types";

export class RpcValueMapper {
  object(value: unknown, name: string): RpcObject {
    if (!this.isObject(value)) throw new Error(`Invalid ${name}`);
    return value;
  }

  isObject(value: unknown): value is RpcObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  string(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  requiredString(value: unknown, name: string): string {
    if (typeof value !== "string") throw new Error(`Invalid ${name}`);
    return value;
  }

  requiredNumber(value: unknown, name: string): number {
    if (typeof value !== "number") throw new Error(`Missing ${name}`);
    return value;
  }

  number(value: unknown): number {
    return Number(this.bigint(value));
  }

  bigint(value: unknown): bigint {
    if (value === undefined || value === null) return 0n;
    return BigInt(String(value));
  }

  requiredBigint(value: unknown, name: string): bigint {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new Error(`Invalid ${name}`);
    }
    return BigInt(value);
  }

  felt(value: string): `0x${string}` {
    if (!/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new Error(`Invalid field element: ${value}`);
    }
    return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  }

  optionalFelt(value: string | undefined): `0x${string}` | undefined {
    return value === undefined ? undefined : this.felt(value);
  }

  requiredFelt(value: unknown, name: string): `0x${string}` {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new Error(`Invalid ${name}`);
    }
    return this.felt(value);
  }

  feltArray(value: unknown): `0x${string}`[] {
    return this.array(value).map((item) => this.felt(String(item)));
  }

  requiredFeltArray(value: unknown, name: string): `0x${string}`[] {
    if (!Array.isArray(value)) throw new Error(`Invalid ${name}`);
    return value.map((item, index) =>
      this.requiredFelt(item, `${name}[${index}]`),
    );
  }

  transactionVersion(value: unknown): bigint {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new Error(`Invalid transaction version: ${String(value)}`);
    }
    return BigInt(value);
  }

  hash256(value: unknown, name: string): Uint8Array {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
      throw new Error(`Invalid ${name}`);
    }
    // NUM_AS_HEX permits unpadded values, while the domain model stores a 32-byte hash.
    const hex = value.slice(2).padStart(64, "0");
    return Uint8Array.from(
      hex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
    );
  }

  normalizedFelt(value: string): string {
    return BigInt(value).toString(16);
  }
}
