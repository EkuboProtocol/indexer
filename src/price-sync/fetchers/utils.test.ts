import { expect, test } from "bun:test";
import { toHexTokenAddress, toPriceUpdates } from "./utils";

test("toHexTokenAddress normalizes decimal and padded addresses", () => {
  expect(toHexTokenAddress("0")).toBe("0x0");
  expect(toHexTokenAddress("15")).toBe("0xf");
  expect(toHexTokenAddress("0x000f")).toBe("0xf");
});

test("toPriceUpdates applies shared chain and timestamp metadata", () => {
  const timestamp = new Date("2026-07-28T12:00:00.000Z");

  expect(
    toPriceUpdates(
      4663n,
      [
        ["0x01", 1],
        ["2", 2.5],
      ],
      timestamp,
    ),
  ).toEqual([
    {
      chainId: 4663n,
      tokenAddress: "0x1",
      timestamp,
      usdPrice: 1,
    },
    {
      chainId: 4663n,
      tokenAddress: "0x2",
      timestamp,
      usdPrice: 2.5,
    },
  ]);
});
