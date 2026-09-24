import { expect, test } from "bun:test";
import { encodeCallPoints, parseExtensionCallPointsSet } from "./core";

test("decodes the deployed LAUNCHY guard registration and swap hook bit positions", () => {
  const address = "0x6d7662a861e570189e5d6967827c4c802842609996b7f2cdf236cb572c930a3";
  const { value } = parseExtensionCallPointsSet(
    [address, "0x1", "0x0", "0x0", "0x0", "0x1", "0x0", "0x0", "0x0"], 0);
  expect(value.extension).toBe(BigInt(address));
  expect(encodeCallPoints(value.call_points)).toBe(17);
  expect(encodeCallPoints({ ...value.call_points, before_swap: true })).toBe(81);
  expect(encodeCallPoints({ ...value.call_points, after_swap: true })).toBe(49);
});
