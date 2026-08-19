/**
 * Maps JSON-RPC receipts to canonical receipt variants and the gas-only
 * execution-resource model exposed by supported RPC specifications.
 */
import type { StarknetRpcTransactionReceipt } from "../block";
import type { RpcObject, RpcReceipt } from "../rpc-types";
import { RpcValueMapper } from "./rpc-value";

export class ReceiptMapper {
  readonly #value = new RpcValueMapper();

  map(
    transaction: RpcObject,
    receipt: RpcReceipt,
    transactionIndex: number,
    transactionHash: `0x${string}`,
  ): StarknetRpcTransactionReceipt {
    const type = this.#value.string(transaction.type)?.toUpperCase();
    const common = {
      filterIds: [] as number[],
      meta: {
        transactionIndex,
        transactionHash,
        actualFee: this.#actualFee(receipt.actual_fee),
        executionResources: this.#executionResources(
          receipt.execution_resources,
        ),
        executionResult:
          this.status(receipt) === "reverted"
            ? ({
                _tag: "reverted",
                reverted: { reason: this.#value.string(receipt.revert_reason) },
              } as const)
            : ({ _tag: "succeeded", succeeded: {} } as const),
      },
    };

    switch (type) {
      case "L1_HANDLER":
        return {
          ...common,
          receipt: {
            _tag: "l1Handler",
            l1Handler: {
              messageHash: this.#value.hash256(
                receipt.message_hash,
                "message_hash",
              ),
            },
          },
        };
      case "DEPLOY":
        return {
          ...common,
          receipt: {
            _tag: "deploy",
            deploy: { contractAddress: this.#contractAddress(receipt) },
          },
        };
      case "DEPLOY_ACCOUNT":
        return {
          ...common,
          receipt: {
            _tag: "deployAccount",
            deployAccount: {
              contractAddress: this.#contractAddress(receipt),
            },
          },
        };
      case "DECLARE":
        return {
          ...common,
          receipt: { _tag: "declare", declare: {} },
        };
      case "INVOKE":
        return {
          ...common,
          receipt: { _tag: "invoke", invoke: {} },
        };
      default:
        throw new Error(
          `Unsupported transaction type: ${String(transaction.type)}`,
        );
    }
  }

  status(receipt: RpcReceipt): "succeeded" | "reverted" {
    switch (receipt.execution_status) {
      case "SUCCEEDED":
        return "succeeded";
      case "REVERTED":
        return "reverted";
      default:
        throw new Error(
          `Unknown receipt execution status: ${String(receipt.execution_status)}`,
        );
    }
  }

  #contractAddress(receipt: RpcReceipt): `0x${string}` {
    return this.#value.requiredFelt(
      receipt.contract_address,
      "contract_address",
    );
  }

  #actualFee(value: unknown): {
    amount: `0x${string}`;
    unit: "wei" | "fri" | "unknown";
  } {
    if (typeof value === "string") {
      return {
        amount: this.#value.requiredFelt(value, "actual_fee"),
        unit: "wei",
      };
    }
    if (!this.#value.isObject(value)) {
      throw new Error("Invalid actual_fee");
    }
    const unit = this.#value.string(value.unit)?.toUpperCase();
    if (unit !== "WEI" && unit !== "FRI") {
      throw new Error(`Invalid actual_fee unit: ${String(value.unit)}`);
    }
    return {
      amount: this.#value.requiredFelt(value.amount, "actual_fee amount"),
      unit: unit === "WEI" ? "wei" : "fri",
    };
  }

  #executionResources(value: unknown): {
    l1Gas: bigint;
    l1DataGas: bigint;
    l2Gas: bigint;
  } {
    if (!this.#value.isObject(value)) {
      throw new Error("Invalid execution_resources");
    }
    const total = this.#value.isObject(value.total_gas_consumed)
      ? value.total_gas_consumed
      : value;
    const data = this.#value.isObject(value.data_availability)
      ? value.data_availability
      : {};
    return {
      l1Gas: this.#value.bigint(total.l1_gas ?? data.l1_gas),
      l1DataGas: this.#value.bigint(total.l1_data_gas ?? data.l1_data_gas),
      l2Gas: this.#value.bigint(total.l2_gas),
    };
  }
}
