import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import {
  decodeUint256,
  readingFromResults,
  readUiMultipliers,
  selectTokensToRead,
  type CallResult,
  type UiMultiplierClient,
} from "./uiMultiplier";

const word = (value: bigint): Hex =>
  encodeAbiParameters([{ type: "uint256" }], [value]);
const ok = (value: bigint): CallResult => ({
  success: true,
  returnData: word(value),
});
const reverted: CallResult = { success: false, returnData: "0x" };

const E18 = 10n ** 18n;
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";

describe("decodeUint256", () => {
  test("reads exactly one word", () => {
    expect(decodeUint256(ok(8n * E18))).toBe(8n * E18);
  });

  test("a revert, empty data or a longer result is no value", () => {
    expect(decodeUint256(reverted)).toBeNull();
    expect(decodeUint256({ success: true, returnData: "0x" })).toBeNull();
    expect(
      decodeUint256({
        success: true,
        returnData: `${word(1n)}${word(2n).slice(2)}`,
      }),
    ).toBeNull();
    expect(decodeUint256(undefined)).toBeNull();
  });
});

describe("readingFromResults", () => {
  test("keeps the scheduled change next to the current value", () => {
    expect(
      readingFromResults([ok(8n * E18), ok(8n * E18), ok(1795185000n)]),
    ).toEqual({
      uiMultiplier: 8n * E18,
      newUiMultiplier: 8n * E18,
      effectiveAt: 1795185000n,
    });
  });

  test("a token without uiMultiplier() has no reading", () => {
    expect(readingFromResults([reverted, reverted, reverted])).toBeNull();
    expect(
      readingFromResults([
        { success: true, returnData: "0x" },
        reverted,
        reverted,
      ]),
    ).toBeNull();
  });

  test("a zero multiplier is treated as none", () => {
    expect(readingFromResults([ok(0n), ok(0n), ok(0n)])).toBeNull();
  });

  test("the schedule is optional", () => {
    expect(readingFromResults([ok(E18), reverted, reverted])).toEqual({
      uiMultiplier: E18,
      newUiMultiplier: null,
      effectiveAt: null,
    });
  });
});

describe("selectTokensToRead", () => {
  const base = {
    stored: new Set([1n]),
    absentProbedAt: new Map([
      [2n, 8_000],
      [3n, 0],
    ]),
    nowMs: 10_000,
    absentReprobeMs: 5_000,
  };

  test("re-reads stored tokens, probes new ones and stale absent ones", () => {
    expect(selectTokensToRead({ ...base, tokens: [1n, 2n, 3n, 4n] })).toEqual([
      1n,
      3n,
      4n,
    ]);
  });

  test("probes absent tokens again only once the interval has passed", () => {
    expect(
      selectTokensToRead({ ...base, tokens: [2n], nowMs: 12_999 }),
    ).toEqual([]);
    expect(
      selectTokensToRead({ ...base, tokens: [2n], nowMs: 13_000 }),
    ).toEqual([2n]);
  });

  test("skips the native token alias and values that are not addresses", () => {
    expect(selectTokensToRead({ ...base, tokens: [0n, 1n << 160n] })).toEqual(
      [],
    );
  });
});

describe("readUiMultipliers", () => {
  const selectors = [
    "uiMultiplier()",
    "newUIMultiplier()",
    "effectiveAt()",
  ].map((signature) => toFunctionSelector(signature));

  function fakeClient(values: Map<bigint, bigint>, calls: number[] = []) {
    const client: UiMultiplierClient = {
      readContract: ({ address, args: [requests] }) => {
        expect(address).toBe(MULTICALL);
        calls.push(requests.length);
        return Promise.resolve(
          requests.map(({ target, callData, allowFailure }) => {
            expect(allowFailure).toBe(true);
            const value = values.get(BigInt(target));
            if (value === undefined) return reverted;
            const ix = selectors.indexOf(callData);
            return ok(ix === 2 ? 1795185000n : value);
          }),
        );
      },
    };
    return client;
  }

  test("reads every token in chunks of three calls per token", async () => {
    const calls: number[] = [];
    const readings = await readUiMultipliers(
      fakeClient(new Map([[0xb90an, 8n * E18]]), calls),
      MULTICALL,
      [0xb90an, 0x1234n, 0x5678n],
      2,
    );
    expect(calls).toEqual([6, 3]);
    expect(readings.get(0xb90an)).toEqual({
      uiMultiplier: 8n * E18,
      newUiMultiplier: 8n * E18,
      effectiveAt: 1795185000n,
    });
    expect(readings.get(0x1234n)).toBeNull();
    expect(readings.get(0x5678n)).toBeNull();
  });

  test("an RPC failure fails the read instead of reporting no multipliers", async () => {
    const client: UiMultiplierClient = {
      readContract: () => Promise.reject(new Error("rate limited")),
    };
    expect(readUiMultipliers(client, MULTICALL, [1n])).rejects.toThrow(
      "rate limited",
    );
  });

  test("a short Multicall3 result fails the read", async () => {
    const client: UiMultiplierClient = {
      readContract: () => Promise.resolve([ok(E18)]),
    };
    expect(readUiMultipliers(client, MULTICALL, [1n])).rejects.toThrow(
      "Multicall3 returned 1 results for 3 calls",
    );
  });
});
