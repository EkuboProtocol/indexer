import { describe, expect, it } from "vitest";
import { parseTwammVirtualOrdersExecuted } from "./twammEvent.ts";

describe(parseTwammVirtualOrdersExecuted, () => {
  it("works for example", () => {
    expect(
      parseTwammVirtualOrdersExecuted(
        "0x12f9571ed354b82e74b3b03938d2d7d26c61897be74024a7170b8052743de8b90000000000ca1c01357e84b027e90000000000000000000000000000",
      ),
    ).toMatchInlineSnapshot(`
      {
        "poolId": "0x12f9571ed354b82e74b3b03938d2d7d26c61897be74024a7170b8052743de8b9",
        "saleRateToken0": 3728260255814876407785n,
        "saleRateToken1": 0n,
      }
    `);
  });
});
