import { describe, expect, it } from "bun:test";
import { createLogProcessorsV3 } from "./logProcessorsV3";

const config = {
  mevCaptureAddress: "0x0000000000000000000000000000000000000001",
  boostedFeesConcentratedAddress: "0x0000000000000000000000000000000000000002",
  boostedFeesStableswapAddress: "0x0000000000000000000000000000000000000003",
  coreAddress: "0x0000000000000000000000000000000000000004",
  oracleAddress: "0x0000000000000000000000000000000000000005",
  incentivesAddress: "0x0000000000000000000000000000000000000006",
  tokenWrapperFactoryAddress: "0x0000000000000000000000000000000000000007",
  auctionsAddress: "0x0000000000000000000000000000000000000008",
  positionsContracts: [],
} as const;

describe("createLogProcessorsV3", () => {
  it("creates identical TWAMM and Orders processors for current and legacy addresses", () => {
    const twammAddress = "0x0000000000000000000000000000000000000010";
    const legacyTwammAddress = "0x0000000000000000000000000000000000000011";
    const ordersAddress = "0x0000000000000000000000000000000000000012";
    const legacyOrdersAddress = "0x0000000000000000000000000000000000000013";

    const processors = createLogProcessorsV3({
      ...config,
      twammAddresses: [twammAddress, legacyTwammAddress],
      ordersAddresses: [ordersAddress, legacyOrdersAddress],
    });

    expect(processors.filter((p) => p.address === twammAddress)).toHaveLength(
      3,
    );
    expect(
      processors.filter((p) => p.address === legacyTwammAddress),
    ).toHaveLength(3);
    expect(processors.filter((p) => p.address === ordersAddress)).toHaveLength(
      1,
    );
    expect(
      processors.filter((p) => p.address === legacyOrdersAddress),
    ).toHaveLength(1);
  });
});
