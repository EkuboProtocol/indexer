import { describe, expect, it, mock } from "bun:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { CONTINUOUS_AUCTION_ABI, VE33_ABI } from "./abis_v3";
import {
  continuousAuctionBidderId,
  createLogProcessorsV3,
} from "./logProcessorsV3";

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
    // The solc 0.8.33 recompile moved Orders to a third address, and chains
    // run one generation or the other, so all of them are watched at once.
    const recompiledOrdersAddress =
      "0x0000000000000000000000000000000000000014";

    const processors = createLogProcessorsV3({
      ...config,
      twammAddresses: [twammAddress, legacyTwammAddress],
      ordersAddresses: [
        ordersAddress,
        legacyOrdersAddress,
        recompiledOrdersAddress,
      ],
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
    expect(
      processors.filter((p) => p.address === recompiledOrdersAddress),
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

  it("indexes ContinuousAuction bid updates and settlements only when configured", () => {
    const continuousAuctionAddress =
      "0x0000000000000000000000000000000000000040";
    const base = { ...config, twammAddresses: [], ordersAddresses: [] };

    expect(
      createLogProcessorsV3(base).filter(
        (p) => p.address === continuousAuctionAddress,
      ),
    ).toHaveLength(0);
    // BidUpdated, RentAccrued, RentUnallocated, RentCollected, SwapFeeCharged
    expect(
      createLogProcessorsV3({ ...base, continuousAuctionAddress }).filter(
        (p) => p.address === continuousAuctionAddress,
      ),
    ).toHaveLength(5);
  });

  it("derives the bidder id the way ContinuousAuctionLib.bidderId does", () => {
    // cast keccak $(cast abi-encode "f(address,bytes32)" 0x..aa 0x..bb)
    expect(
      continuousAuctionBidderId(
        "0x00000000000000000000000000000000000000aa",
        `0x${"bb".padStart(64, "0")}`,
      ),
    ).toBe(
      "0xe75341cef40916e44766738c5c2fc48518809c87d2843a8bec425b4bc23f242e",
    );
  });

  it("passes BidUpdated through with the bidder id", async () => {
    const continuousAuctionAddress =
      "0x0000000000000000000000000000000000000040";
    const processors = createLogProcessorsV3({
      ...config,
      twammAddresses: [],
      ordersAddresses: [],
      continuousAuctionAddress,
    });
    const poolId = `0x${"41".padStart(64, "0")}` as const;
    const locker = "0x00000000000000000000000000000000000000aa";
    const salt = `0x${"bb".padStart(64, "0")}` as const;
    const executor = "0x0000000000000000000000000000000000000042";
    const topics = encodeEventTopics({
      abi: CONTINUOUS_AUCTION_ABI,
      eventName: "BidUpdated",
      args: { poolId, locker },
    });
    const processor = processors.find(
      (candidate) =>
        candidate.address === continuousAuctionAddress &&
        candidate.filter.topics[0] === topics[0],
    );
    expect(processor).toBeDefined();

    const insertContinuousAuctionBidUpdatedEvent = mock(async () => {});
    await processor!.handler(
      { insertContinuousAuctionBidUpdatedEvent } as never,
      {
        blockNumber: 1,
        transactionIndex: 2,
        eventIndex: 3,
        emitter: continuousAuctionAddress,
        transactionHash: `0x${"50".padStart(64, "0")}`,
      },
      {
        topics,
        data: encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "uint96" },
            { type: "uint48" },
            { type: "uint48" },
            { type: "address" },
            { type: "uint32" },
            { type: "int256" },
          ],
          [salt, 7n, 1_700_000_001, 1_700_000_101, executor, 1n << 31n, -5n],
        ),
      },
    );

    expect(insertContinuousAuctionBidUpdatedEvent).toHaveBeenCalledWith(
      expect.anything(),
      {
        coreAddress: config.coreAddress,
        poolId,
        // viem checksums decoded addresses
        locker: "0x00000000000000000000000000000000000000AA",
        salt,
        bidder:
          "0xe75341cef40916e44766738c5c2fc48518809c87d2843a8bec425b4bc23f242e",
        rate: 7n,
        start: 1_700_000_001,
        end: 1_700_000_101,
        executor,
        fee: 2 ** 31,
        delta: -5n,
      },
    );
  });

  it("splits RentCollected's position id into salt and bounds", async () => {
    const continuousAuctionAddress =
      "0x0000000000000000000000000000000000000040";
    const processors = createLogProcessorsV3({
      ...config,
      twammAddresses: [],
      ordersAddresses: [],
      continuousAuctionAddress,
    });
    const poolId = `0x${"41".padStart(64, "0")}` as const;
    const owner = "0x00000000000000000000000000000000000000cc";
    // salt 9 (the NFT id), lower -10, upper 20
    const positionId = `0x${(
      (9n << 64n) |
      (BigInt.asUintN(32, -10n) << 32n) |
      20n
    )
      .toString(16)
      .padStart(64, "0")}` as const;
    const topics = encodeEventTopics({
      abi: CONTINUOUS_AUCTION_ABI,
      eventName: "RentCollected",
      args: { poolId, owner },
    });
    const processor = processors.find(
      (candidate) =>
        candidate.address === continuousAuctionAddress &&
        candidate.filter.topics[0] === topics[0],
    );
    expect(processor).toBeDefined();

    const insertContinuousAuctionRentCollectedEvent = mock(async () => {});
    await processor!.handler(
      { insertContinuousAuctionRentCollectedEvent } as never,
      {
        blockNumber: 1,
        transactionIndex: 2,
        eventIndex: 3,
        emitter: continuousAuctionAddress,
        transactionHash: `0x${"50".padStart(64, "0")}`,
      },
      {
        topics,
        data: encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256" }],
          [positionId, 123n],
        ),
      },
    );

    expect(insertContinuousAuctionRentCollectedEvent).toHaveBeenCalledWith(
      expect.anything(),
      {
        coreAddress: config.coreAddress,
        poolId,
        owner,
        positionId,
        salt: 9n,
        bounds: { lower: -10, upper: 20 },
        amount: 123n,
      },
    );
  });
});
