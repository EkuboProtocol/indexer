import { describe, expect, it, mock } from "bun:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { VE33_ABI } from "./abis_v3";
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

  it("indexes both the voted and effective swap fees", async () => {
    const ve33Address = "0x0000000000000000000000000000000000000020";
    const processors = createLogProcessorsV3({
      ...config,
      twammAddresses: [],
      ordersAddresses: [],
      ve33Address,
    });
    const topics = encodeEventTopics({
      abi: VE33_ABI,
      eventName: "VoteWeightApplied",
    });
    const processor = processors.find(
      (candidate) =>
        candidate.address === ve33Address &&
        candidate.filter.topics[0] === topics[0],
    );
    expect(processor).toBeDefined();

    const insertVe33VoteWeightAppliedEvent = mock(async () => {});
    const owner = "0x0000000000000000000000000000000000000030";
    const stakeId = `0x${((12n << 64n) | 1_800_000_000n).toString(16).padStart(64, "0")}` as const;
    const poolId = `0x${"40".padStart(64, "0")}` as const;

    await processor!.handler(
      { insertVe33VoteWeightAppliedEvent } as never,
      {
        blockNumber: 1,
        transactionIndex: 2,
        eventIndex: 3,
        emitter: ve33Address,
        transactionHash: `0x${"50".padStart(64, "0")}`,
      },
      {
        topics,
        data: encodeAbiParameters(
          [
            { type: "address" },
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint128" },
            { type: "uint64" },
            { type: "uint64" },
          ],
          [owner, stakeId, poolId, 123n, 17n, 45n],
        ),
      },
    );

    expect(insertVe33VoteWeightAppliedEvent).toHaveBeenCalledWith(
      expect.anything(),
      {
        coreAddress: config.coreAddress,
        poolId,
        owner,
        stake: { id: stakeId, salt: 12n, endTime: 1_800_000_000n },
        weight: 123n,
        votedSwapFee: 17n,
        swapFee: 45n,
      },
    );
  });
});
