/**
 * Maps RPC transaction traces and reconnects invocation-local event/message
 * orders to the block-global indices assigned by ReceiptBlockMapper.
 */
import type {
  Event,
  FunctionInvocation,
  MessageToL1,
  Transaction,
  TransactionTrace,
} from "@apibara/starknet";
import type { RpcObject } from "../rpc-types";
import { RpcValueMapper } from "./rpc-value";

type TraceBase = Pick<
  TransactionTrace,
  "filterIds" | "transactionIndex" | "transactionHash"
>;

export class TraceMapper {
  readonly #value = new RpcValueMapper();

  map(
    values: readonly unknown[],
    transactions: readonly Transaction[],
    events: readonly Event[],
    messages: readonly MessageToL1[],
  ): TransactionTrace[] {
    const transactionsByHash = new Map(
      transactions.map((transaction) => [
        this.#value.normalizedFelt(transaction.meta.transactionHash),
        transaction,
      ]),
    );

    return values.flatMap((value) => {
      const object = this.#value.object(value, "trace");
      const hash = this.#value.felt(
        this.#value.string(object.transaction_hash) ?? "0x0",
      );
      const transaction = transactionsByHash.get(
        this.#value.normalizedFelt(hash),
      );
      if (!transaction) return [];

      const transactionIndex = transaction.meta.transactionIndex;
      const invocation = new InvocationMapper(
        this.#eventIndices(events, transactionIndex),
        this.#messageIndices(messages, transactionIndex),
      );
      const root = this.#value.object(object.trace_root, "trace root");
      const trace = this.#mapRoot(
        root,
        {
          filterIds: [],
          transactionIndex,
          transactionHash: hash,
        },
        invocation,
      );
      return trace ? [trace] : [];
    });
  }

  #mapRoot(
    root: RpcObject,
    base: TraceBase,
    invocation: InvocationMapper,
  ): TransactionTrace | undefined {
    switch (this.#value.string(root.type)?.toUpperCase()) {
      case "INVOKE":
        return this.#mapInvoke(root, base, invocation);
      case "DECLARE":
        return this.#mapDeclare(root, base, invocation);
      case "DEPLOY_ACCOUNT":
        return this.#mapDeployAccount(root, base, invocation);
      case "L1_HANDLER":
        return this.#mapL1Handler(root, base, invocation);
      default:
        return undefined;
    }
  }

  #mapInvoke(
    root: RpcObject,
    base: TraceBase,
    invocation: InvocationMapper,
  ): TransactionTrace {
    const execute = root.execute_invocation;
    const reverted =
      this.#value.isObject(execute) &&
      typeof execute.revert_reason === "string";
    return {
      ...base,
      traceRoot: {
        _tag: "invoke",
        invoke: {
          validateInvocation: invocation.optional(root.validate_invocation),
          executeInvocation: reverted
            ? {
                _tag: "reverted",
                reverted: {
                  reason: this.#value.string(execute.revert_reason),
                },
              }
            : { _tag: "success", success: invocation.map(execute) },
          feeTransferInvocation: invocation.optional(
            root.fee_transfer_invocation,
          ),
        },
      },
    };
  }

  #mapDeclare(
    root: RpcObject,
    base: TraceBase,
    invocation: InvocationMapper,
  ): TransactionTrace {
    return {
      ...base,
      traceRoot: {
        _tag: "declare",
        declare: {
          validateInvocation: invocation.optional(root.validate_invocation),
          feeTransferInvocation: invocation.optional(
            root.fee_transfer_invocation,
          ),
        },
      },
    };
  }

  #mapDeployAccount(
    root: RpcObject,
    base: TraceBase,
    invocation: InvocationMapper,
  ): TransactionTrace {
    return {
      ...base,
      traceRoot: {
        _tag: "deployAccount",
        deployAccount: {
          validateInvocation: invocation.optional(root.validate_invocation),
          constructorInvocation: invocation.optional(
            root.constructor_invocation,
          ),
          feeTransferInvocation: invocation.optional(
            root.fee_transfer_invocation,
          ),
        },
      },
    };
  }

  #mapL1Handler(
    root: RpcObject,
    base: TraceBase,
    invocation: InvocationMapper,
  ): TransactionTrace {
    return {
      ...base,
      traceRoot: {
        _tag: "l1Handler",
        l1Handler: {
          functionInvocation: invocation.optional(root.function_invocation),
        },
      },
    };
  }

  #eventIndices(
    events: readonly Event[],
    transactionIndex: number,
  ): Map<number, number> {
    return new Map(
      events
        .filter((event) => event.transactionIndex === transactionIndex)
        .map((event) => [event.eventIndexInTransaction, event.eventIndex]),
    );
  }

  #messageIndices(
    messages: readonly MessageToL1[],
    transactionIndex: number,
  ): Map<number, number> {
    return new Map(
      messages
        .filter((message) => message.transactionIndex === transactionIndex)
        .map((message) => [
          message.messageIndexInTransaction,
          message.messageIndex,
        ]),
    );
  }
}

/**
 * Owns recursive invocation mapping plus the local-to-global index lookup
 * required by nested calls.
 */
class InvocationMapper {
  readonly #value = new RpcValueMapper();

  constructor(
    readonly eventIndices: ReadonlyMap<number, number>,
    readonly messageIndices: ReadonlyMap<number, number>,
  ) {}

  map(value: unknown): FunctionInvocation {
    const object = this.#value.object(value, "function invocation");
    return {
      contractAddress: this.#value.felt(
        this.#value.string(object.contract_address) ?? "0x0",
      ),
      entryPointSelector: this.#value.felt(
        this.#value.string(object.entry_point_selector) ?? "0x0",
      ),
      calldata: this.#value.feltArray(object.calldata),
      callerAddress: this.#value.felt(
        this.#value.string(object.caller_address) ?? "0x0",
      ),
      classHash: this.#value.felt(
        this.#value.string(object.class_hash) ?? "0x0",
      ),
      callType: this.#callType(object.call_type),
      result: this.#value.feltArray(object.result),
      calls: this.#value.array(object.calls).map((call) => this.map(call)),
      events: this.#orderedIndices(object.events, this.eventIndices, "event"),
      messages: this.#orderedIndices(
        object.messages,
        this.messageIndices,
        "message",
      ),
    };
  }

  optional(value: unknown): FunctionInvocation | undefined {
    return this.#value.isObject(value) ? this.map(value) : undefined;
  }

  #orderedIndices(
    value: unknown,
    globalIndices: ReadonlyMap<number, number>,
    name: string,
  ): number[] {
    return this.#value.array(value).map((entry) => {
      const order = this.#value.number(
        this.#value.object(entry, `ordered ${name}`).order,
      );
      return globalIndices.get(order) ?? order;
    });
  }

  #callType(value: unknown): FunctionInvocation["callType"] {
    return value === "CALL"
      ? "call"
      : value === "DELEGATE"
        ? "delegate"
        : value === "LIBRARY_CALL"
          ? "libraryCall"
          : "unknown";
  }
}
