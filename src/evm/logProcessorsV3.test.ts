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

  it("adds Ve33 event and NFT transfer processors when Ve33 addresses are configured", () => {
    const ve33Address = "0x0000000000000000000000000000000000000020";
    const veTokenAddress = "0x0000000000000000000000000000000000000021";
    const ve33PositionsAddress = "0x0000000000000000000000000000000000000022";

    const processors = createLogProcessorsV3({
      ...config,
      twammAddresses: ["0x0000000000000000000000000000000000000010"],
      ordersAddresses: ["0x0000000000000000000000000000000000000012"],
      ve33Address,
      veTokenAddress,
      ve33PositionsAddress,
    });

    expect(processors.filter((p) => p.address === ve33Address)).toHaveLength(
      7,
    );
    expect(
      processors.filter((p) => p.address === veTokenAddress),
    ).toHaveLength(1);
    expect(
      processors.filter((p) => p.address === ve33PositionsAddress),
    ).toHaveLength(1);
  });

  it("deduplicates Ve33 positions transfers from protocol fee config", () => {
    const ve33PositionsAddress = "0x0000000000000000000000000000000000000022";

    const processors = createLogProcessorsV3({
      ...config,
      twammAddresses: ["0x0000000000000000000000000000000000000010"],
      ordersAddresses: ["0x0000000000000000000000000000000000000012"],
      ve33PositionsAddress,
      positionsContracts: [
        {
          address: ve33PositionsAddress,
          swapProtocolFee: 0n,
          withdrawalProtocolFeeDivisor: 0n,
        },
      ],
    });

    expect(
      processors.filter((p) => p.address === ve33PositionsAddress),
    ).toHaveLength(1);
  });
});
