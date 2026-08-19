/**
 * Maps every supported Starknet JSON-RPC transaction variant to the canonical
 * discriminated transaction model used by @apibara/starknet.
 */
import type { Transaction } from "@apibara/starknet";
import type { RpcObject } from "../rpc-types";
import { RpcValueMapper } from "./rpc-value";

type TransactionBase = Pick<Transaction, "filterIds" | "meta">;

export class TransactionMapper {
  readonly #value = new RpcValueMapper();

  map(
    value: RpcObject,
    transactionIndex: number,
    transactionHash: `0x${string}`,
    status: "succeeded" | "reverted",
  ): Transaction {
    const type = this.#value.string(value.type)?.toUpperCase();
    const base = this.#base(transactionIndex, transactionHash, status);

    switch (type) {
      case "INVOKE":
        return this.#mapInvoke(
          value,
          this.#value.transactionVersion(value.version),
          base,
        );
      case "DECLARE":
        return this.#mapDeclare(
          value,
          this.#value.transactionVersion(value.version),
          base,
        );
      case "DEPLOY_ACCOUNT":
        return this.#mapDeployAccount(
          value,
          this.#value.transactionVersion(value.version),
          base,
        );
      case "DEPLOY":
        this.#requireVersion(type, value.version, 0n);
        return this.#mapDeploy(value, base);
      case "L1_HANDLER":
        this.#requireVersion(type, value.version, 0n);
        return this.#mapL1Handler(value, base);
      default:
        throw new Error(`Unsupported transaction type: ${String(value.type)}`);
    }
  }

  #base(
    transactionIndex: number,
    transactionHash: `0x${string}`,
    transactionStatus: "succeeded" | "reverted",
  ): TransactionBase {
    return {
      filterIds: [],
      meta: { transactionIndex, transactionHash, transactionStatus },
    };
  }

  #mapInvoke(
    value: RpcObject,
    version: bigint,
    base: TransactionBase,
  ): Transaction {
    this.#requireSupportedVersion("INVOKE", version, [0n, 1n, 3n]);
    const signature = this.#value.requiredFeltArray(
      value.signature,
      "signature",
    );
    if (version === 0n) {
      return {
        ...base,
        transaction: {
          _tag: "invokeV0",
          invokeV0: {
            maxFee: this.#value.requiredFelt(value.max_fee, "max_fee"),
            signature,
            contractAddress: this.#value.requiredFelt(
              value.contract_address,
              "contract_address",
            ),
            entryPointSelector: this.#value.requiredFelt(
              value.entry_point_selector,
              "entry_point_selector",
            ),
            calldata: this.#value.requiredFeltArray(value.calldata, "calldata"),
          },
        },
      };
    }
    if (version === 3n) {
      return {
        ...base,
        transaction: {
          _tag: "invokeV3",
          invokeV3: {
            senderAddress: this.#value.requiredFelt(
              value.sender_address,
              "sender_address",
            ),
            calldata: this.#value.requiredFeltArray(value.calldata, "calldata"),
            signature,
            nonce: this.#value.requiredFelt(value.nonce, "nonce"),
            resourceBounds: this.#resourceBounds(value.resource_bounds),
            tip: this.#value.requiredBigint(value.tip, "tip"),
            paymasterData: this.#value.requiredFeltArray(
              value.paymaster_data,
              "paymaster_data",
            ),
            accountDeploymentData: this.#value.requiredFeltArray(
              value.account_deployment_data,
              "account_deployment_data",
            ),
            nonceDataAvailabilityMode: this.#dataAvailabilityMode(
              value.nonce_data_availability_mode,
            ),
            feeDataAvailabilityMode: this.#dataAvailabilityMode(
              value.fee_data_availability_mode,
            ),
          },
        },
      };
    }
    if (version === 1n) {
      return {
        ...base,
        transaction: {
          _tag: "invokeV1",
          invokeV1: {
            senderAddress: this.#value.requiredFelt(
              value.sender_address,
              "sender_address",
            ),
            calldata: this.#value.requiredFeltArray(value.calldata, "calldata"),
            maxFee: this.#value.requiredFelt(value.max_fee, "max_fee"),
            signature,
            nonce: this.#value.requiredFelt(value.nonce, "nonce"),
          },
        },
      };
    }
    return this.#unsupportedVersion("INVOKE", version);
  }

  #mapDeclare(
    value: RpcObject,
    version: bigint,
    base: TransactionBase,
  ): Transaction {
    this.#requireSupportedVersion("DECLARE", version, [0n, 1n, 2n, 3n]);
    const signature = this.#value.requiredFeltArray(
      value.signature,
      "signature",
    );
    const declareBase = {
      senderAddress: this.#value.requiredFelt(
        value.sender_address,
        "sender_address",
      ),
      signature,
      classHash: this.#value.requiredFelt(value.class_hash, "class_hash"),
    };
    if (version === 0n) {
      return {
        ...base,
        transaction: {
          _tag: "declareV0",
          declareV0: {
            ...declareBase,
            maxFee: this.#value.requiredFelt(value.max_fee, "max_fee"),
          },
        },
      };
    }
    if (version === 1n) {
      return {
        ...base,
        transaction: {
          _tag: "declareV1",
          declareV1: {
            ...declareBase,
            maxFee: this.#value.requiredFelt(value.max_fee, "max_fee"),
            nonce: this.#value.requiredFelt(value.nonce, "nonce"),
          },
        },
      };
    }
    const compiledClassHash = this.#value.requiredFelt(
      value.compiled_class_hash,
      "compiled_class_hash",
    );
    if (version === 2n) {
      return {
        ...base,
        transaction: {
          _tag: "declareV2",
          declareV2: {
            ...declareBase,
            compiledClassHash,
            maxFee: this.#value.requiredFelt(value.max_fee, "max_fee"),
            nonce: this.#value.requiredFelt(value.nonce, "nonce"),
          },
        },
      };
    }
    if (version === 3n) {
      return {
        ...base,
        transaction: {
          _tag: "declareV3",
          declareV3: {
            ...declareBase,
            compiledClassHash,
            nonce: this.#value.requiredFelt(value.nonce, "nonce"),
            resourceBounds: this.#resourceBounds(value.resource_bounds),
            tip: this.#value.requiredBigint(value.tip, "tip"),
            paymasterData: this.#value.requiredFeltArray(
              value.paymaster_data,
              "paymaster_data",
            ),
            accountDeploymentData: this.#value.requiredFeltArray(
              value.account_deployment_data,
              "account_deployment_data",
            ),
            nonceDataAvailabilityMode: this.#dataAvailabilityMode(
              value.nonce_data_availability_mode,
            ),
            feeDataAvailabilityMode: this.#dataAvailabilityMode(
              value.fee_data_availability_mode,
            ),
          },
        },
      };
    }
    return this.#unsupportedVersion("DECLARE", version);
  }

  #mapDeployAccount(
    value: RpcObject,
    version: bigint,
    base: TransactionBase,
  ): Transaction {
    this.#requireSupportedVersion("DEPLOY_ACCOUNT", version, [1n, 3n]);
    const deployBase = {
      signature: this.#value.requiredFeltArray(value.signature, "signature"),
      nonce: this.#value.requiredFelt(value.nonce, "nonce"),
      contractAddressSalt: this.#value.requiredFelt(
        value.contract_address_salt,
        "contract_address_salt",
      ),
      constructorCalldata: this.#value.requiredFeltArray(
        value.constructor_calldata,
        "constructor_calldata",
      ),
      classHash: this.#value.requiredFelt(value.class_hash, "class_hash"),
    };
    if (version === 3n) {
      return {
        ...base,
        transaction: {
          _tag: "deployAccountV3",
          deployAccountV3: {
            ...deployBase,
            resourceBounds: this.#resourceBounds(value.resource_bounds),
            tip: this.#value.requiredBigint(value.tip, "tip"),
            paymasterData: this.#value.requiredFeltArray(
              value.paymaster_data,
              "paymaster_data",
            ),
            nonceDataAvailabilityMode: this.#dataAvailabilityMode(
              value.nonce_data_availability_mode,
            ),
            feeDataAvailabilityMode: this.#dataAvailabilityMode(
              value.fee_data_availability_mode,
            ),
          },
        },
      };
    }
    if (version === 1n) {
      return {
        ...base,
        transaction: {
          _tag: "deployAccountV1",
          deployAccountV1: {
            ...deployBase,
            maxFee: this.#value.requiredFelt(value.max_fee, "max_fee"),
          },
        },
      };
    }
    return this.#unsupportedVersion("DEPLOY_ACCOUNT", version);
  }

  #mapDeploy(value: RpcObject, base: TransactionBase): Transaction {
    return {
      ...base,
      transaction: {
        _tag: "deploy",
        deploy: {
          contractAddressSalt: this.#value.requiredFelt(
            value.contract_address_salt,
            "contract_address_salt",
          ),
          constructorCalldata: this.#value.requiredFeltArray(
            value.constructor_calldata,
            "constructor_calldata",
          ),
          classHash: this.#value.requiredFelt(value.class_hash, "class_hash"),
        },
      },
    };
  }

  #mapL1Handler(value: RpcObject, base: TransactionBase): Transaction {
    return {
      ...base,
      transaction: {
        _tag: "l1Handler",
        l1Handler: {
          nonce: this.#value.requiredBigint(value.nonce, "nonce"),
          contractAddress: this.#value.requiredFelt(
            value.contract_address,
            "contract_address",
          ),
          entryPointSelector: this.#value.requiredFelt(
            value.entry_point_selector,
            "entry_point_selector",
          ),
          calldata: this.#value.requiredFeltArray(value.calldata, "calldata"),
        },
      },
    };
  }

  #resourceBounds(value: unknown) {
    const object = this.#value.object(value, "resource_bounds");
    return {
      l1Gas: this.#singleResourceBounds(object.l1_gas),
      l2Gas: this.#singleResourceBounds(object.l2_gas),
    };
  }

  #singleResourceBounds(value: unknown) {
    const object = this.#value.object(value, "resource bound");
    return {
      maxAmount: this.#value.requiredBigint(object.max_amount, "max_amount"),
      maxPricePerUnit: this.#value.requiredBigint(
        object.max_price_per_unit,
        "max_price_per_unit",
      ),
    };
  }

  #dataAvailabilityMode(value: unknown): "l1" | "l2" | "unknown" {
    if (value === "L1") return "l1";
    if (value === "L2") return "l2";
    throw new Error(`Invalid data availability mode: ${String(value)}`);
  }

  #requireVersion(type: string, value: unknown, expected: bigint): void {
    const version = this.#value.transactionVersion(value);
    if (version !== expected) this.#unsupportedVersion(type, version);
  }

  #requireSupportedVersion(
    type: string,
    version: bigint,
    supported: readonly bigint[],
  ): void {
    if (!supported.includes(version)) this.#unsupportedVersion(type, version);
  }

  #unsupportedVersion(type: string, version: bigint): never {
    // Query-version flags are only valid for submitted transactions, not mined block data.
    throw new Error(
      `Unsupported ${type} transaction version: 0x${version.toString(16)}`,
    );
  }
}
