import { DAO } from "./dao.ts";
import type { EventKey } from "./processor.ts";
import { POSITIONS_ABI } from "./abis.ts";
import type {
  Abi,
  AbiParameterToPrimitiveType,
  ExtractAbiEvent,
  ExtractAbiEventNames,
} from "abitype";

type ContractEvent<abi extends Abi, N extends ExtractAbiEventNames<abi>> = {
  [P in ExtractAbiEvent<abi, N>["inputs"][number] as P extends {
    name: infer N extends string;
  }
    ? N
    : never]: AbiParameterToPrimitiveType<P>;
};

interface LogProcessor<T extends Abi, N extends ExtractAbiEventNames<T>> {
  address: `0x${string}`;

  abi: T;
  eventName: N;

  handler: (
    dao: DAO,
    key: EventKey,
    event: ContractEvent<T, N>,
  ) => Promise<void>;
}

// todo: can make this way less repetitive. ideally just input the contract ABI and event name and the handler
//  function automatically receives the event
export const LOG_PROCESSORS = [
  <LogProcessor<typeof POSITIONS_ABI, "Transfer">>{
    address: process.env.POSITIONS_ADDRESS as `0x${string}`,
    abi: POSITIONS_ABI,
    eventName: "Transfer",
    async handler(dao, key, parsed) {
      await dao.insertPositionTransferEvent(parsed, key);
    },
  },
];
