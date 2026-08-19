/**
 * Maps a JSON-RPC state diff into the three canonical state collections.
 * Keeping each collection in a dedicated method makes the RPC-to-domain
 * correspondence visible without mixing unrelated state-change variants.
 */
import type {
  ContractChange,
  NonceUpdate,
  StorageDiff,
} from "@apibara/starknet";
import type { StarknetRpcBlock } from "../block";
import type { RpcObject, RpcStateUpdate } from "../rpc-types";
import { RpcValueMapper } from "./rpc-value";

type MappedStateUpdate = Pick<
  StarknetRpcBlock,
  "storageDiffs" | "contractChanges" | "nonceUpdates"
>;

export class StateUpdateMapper {
  readonly #value = new RpcValueMapper();

  map(update: RpcStateUpdate): MappedStateUpdate {
    return {
      storageDiffs: this.#mapStorageDiffs(update.state_diff),
      contractChanges: this.#mapContractChanges(update.state_diff),
      nonceUpdates: this.#mapNonceUpdates(update.state_diff),
    };
  }

  #mapStorageDiffs(diff: RpcObject): StorageDiff[] {
    return this.#value.array(diff.storage_diffs).map((value) => {
      const item = this.#value.object(value, "storage diff");
      return {
        filterIds: [],
        contractAddress: this.#value.felt(
          this.#value.string(item.address) ?? "0x0",
        ),
        storageEntries: this.#value.array(item.storage_entries).map((entry) => {
          const object = this.#value.object(entry, "storage entry");
          return {
            key: this.#value.felt(this.#value.string(object.key) ?? "0x0"),
            value: this.#value.felt(this.#value.string(object.value) ?? "0x0"),
          };
        }),
      };
    });
  }

  #mapContractChanges(diff: RpcObject): ContractChange[] {
    return [
      ...this.#mapDeclaredClasses(diff.declared_classes),
      ...this.#mapDeprecatedDeclaredClasses(diff.deprecated_declared_classes),
      ...this.#mapReplacedClasses(diff.replaced_classes),
      ...this.#mapDeployedContracts(diff.deployed_contracts),
    ];
  }

  #mapDeclaredClasses(value: unknown): ContractChange[] {
    return this.#value.array(value).map((entry) => {
      const item = this.#value.object(entry, "declared class");
      return {
        filterIds: [],
        change: {
          _tag: "declaredClass",
          declaredClass: {
            classHash: this.#value.optionalFelt(
              this.#value.string(item.class_hash),
            ),
            compiledClassHash: this.#value.optionalFelt(
              this.#value.string(item.compiled_class_hash),
            ),
          },
        },
      };
    });
  }

  #mapDeprecatedDeclaredClasses(value: unknown): ContractChange[] {
    return this.#value.array(value).map((classHash) => ({
      filterIds: [],
      change: {
        _tag: "declaredClass",
        declaredClass: {
          classHash: this.#value.optionalFelt(this.#value.string(classHash)),
          compiledClassHash: undefined,
        },
      },
    }));
  }

  #mapReplacedClasses(value: unknown): ContractChange[] {
    return this.#value.array(value).map((entry) => {
      const item = this.#value.object(entry, "replaced class");
      return {
        filterIds: [],
        change: {
          _tag: "replacedClass",
          replacedClass: {
            contractAddress: this.#value.optionalFelt(
              this.#value.string(item.contract_address),
            ),
            classHash: this.#value.optionalFelt(
              this.#value.string(item.class_hash),
            ),
          },
        },
      };
    });
  }

  #mapDeployedContracts(value: unknown): ContractChange[] {
    return this.#value.array(value).map((entry) => {
      const item = this.#value.object(entry, "deployed contract");
      return {
        filterIds: [],
        change: {
          _tag: "deployedContract",
          deployedContract: {
            contractAddress: this.#value.optionalFelt(
              this.#value.string(item.address),
            ),
            classHash: this.#value.optionalFelt(
              this.#value.string(item.class_hash),
            ),
          },
        },
      };
    });
  }

  #mapNonceUpdates(diff: RpcObject): NonceUpdate[] {
    return this.#value.array(diff.nonces).map((value) => {
      const item = this.#value.object(value, "nonce");
      return {
        filterIds: [],
        contractAddress: this.#value.felt(
          this.#value.string(item.contract_address) ?? "0x0",
        ),
        nonce: this.#value.felt(this.#value.string(item.nonce) ?? "0x0"),
      };
    });
  }
}
