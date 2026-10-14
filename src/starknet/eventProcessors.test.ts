import { describe, expect, it, mock } from "bun:test";
import type { DAO } from "../_shared/dao";
import type { EventKey } from "../_shared/eventKey";
import type { PositionFeesCollectedEvent, SavedBalanceEvent } from "./core";
import {
  createEventProcessors,
  type StarknetEventProcessor,
  type StarknetEventProcessorConfig,
} from "./eventProcessors";

const CORE = "0x100" as const;
const POSITIONS = "0x200" as const;
const TOKEN0 = 0x300n;
const TOKEN1 = 0x400n;
const PROTOCOL_FEES_SALT = 0x50524f544f434f4c5f46454553n;

const config: StarknetEventProcessorConfig = {
  coreAddress: CORE,
  positionsAddress: POSITIONS,
  nftAddress: "0x1",
  tokenRegistryAddress: "0x2",
  tokenRegistryV2Address: "0x3",
  tokenRegistryV3Address: "0x4",
  twammAddress: "0x5",
  stakerAddress: "0x6",
  governorAddress: "0x7",
  oracleAddress: "0x8",
  limitOrdersAddress: "0x9",
  splineLiquidityProviderAddress: "0xa",
};

const positionFeesCollected: PositionFeesCollectedEvent = {
  pool_key: {
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 1n,
    tick_spacing: 2n,
    extension: 3n,
  },
  position_key: {
    owner: BigInt(POSITIONS),
    salt: 99n,
    bounds: { lower: -100n, upper: 100n },
  },
  delta: { amount0: -50n, amount1: -75n },
};

function eventKey(eventIndex: number, transactionIndex = 2): EventKey {
  return {
    blockNumber: 123,
    transactionIndex,
    eventIndex,
    emitter: CORE,
    transactionHash: "0xabc",
  };
}

function findProcessor<T>(
  processors: readonly StarknetEventProcessor<any>[],
  selector: `0x${string}`,
): StarknetEventProcessor<T> {
  const processor = processors.find(({ filter }) =>
    filter.keys.includes(selector),
  );
  if (!processor) throw new Error(`Missing processor for ${selector}`);
  return processor;
}

describe("Starknet v5 positions protocol fees", () => {
  it("records exact SavedBalance amounts after a position fee collection", async () => {
    const insertPositionFeesCollectedEvent = mock(async () => {});
    const insertPositionFeesWithheld = mock(async () => {});
    const dao = {
      insertPositionFeesCollectedEvent,
      insertPositionFeesWithheld,
    } as unknown as DAO;
    const processors = createEventProcessors(config);
    const collected = findProcessor<PositionFeesCollectedEvent>(
      processors,
      "0x96982abd597114bdaa4a60612f87fabfcc7206aa12d61c50e7ba1e6c291100",
    );
    const saved = findProcessor<SavedBalanceEvent>(
      processors,
      "0x0048796a25e5ceac9caf95a4618ebfd1516b51e5d994a49d28e22f09c64ad2ee",
    );

    await collected.handle(dao, {
      parsed: positionFeesCollected,
      key: eventKey(10),
    });
    expect(insertPositionFeesWithheld).not.toHaveBeenCalled();

    await saved.handle(dao, {
      parsed: {
        key: {
          owner: BigInt(POSITIONS),
          token: TOKEN0,
          salt: PROTOCOL_FEES_SALT,
        },
        amount: 11n,
      },
      key: eventKey(11),
    });
    await saved.handle(dao, {
      parsed: {
        key: {
          owner: BigInt(POSITIONS),
          token: TOKEN1,
          salt: PROTOCOL_FEES_SALT,
        },
        amount: 17n,
      },
      key: eventKey(12),
    });

    expect(insertPositionFeesWithheld).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ amount0: 11n, amount1: 0n }),
      eventKey(11),
    );
    expect(insertPositionFeesWithheld).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ amount0: 0n, amount1: 17n }),
      eventKey(12),
    );
  });

  it("keeps v4 collections unchanged and ignores unrelated saved balances", async () => {
    const insertPositionFeesWithheld = mock(async () => {});
    const dao = {
      insertPositionFeesCollectedEvent: mock(async () => {}),
      insertPositionFeesWithheld,
    } as unknown as DAO;
    const processors = createEventProcessors(config);
    const collected = findProcessor<PositionFeesCollectedEvent>(
      processors,
      "0x96982abd597114bdaa4a60612f87fabfcc7206aa12d61c50e7ba1e6c291100",
    );
    const saved = findProcessor<SavedBalanceEvent>(
      processors,
      "0x0048796a25e5ceac9caf95a4618ebfd1516b51e5d994a49d28e22f09c64ad2ee",
    );

    await collected.handle(dao, {
      parsed: positionFeesCollected,
      key: eventKey(20),
    });
    await saved.handle(dao, {
      parsed: {
        key: {
          owner: BigInt(POSITIONS),
          token: TOKEN0,
          salt: PROTOCOL_FEES_SALT,
        },
        amount: 11n,
      },
      key: eventKey(21, 3),
    });

    expect(insertPositionFeesWithheld).not.toHaveBeenCalled();
  });
});
