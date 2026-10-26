import { createPublicClient, http } from "viem";
import { loadConfig } from "../src/config";
import { DAO } from "../src/_shared/dao";
import { createEvmEntrypoint, createEvmProcessors } from "../src/evm";
import { createEvmAdapter } from "../src/evm/logStream";
import { logStreamFilters } from "../src/evm/logProcessorsShared";

loadConfig("evm");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const blockNumbers = args.filter((a) => a !== "--apply").map(Number);
if (blockNumbers.length === 0 || !blockNumbers.every(Number.isSafeInteger)) {
  throw new Error("usage: backfillBlocks.ts <block> [block...] [--apply]");
}

const chainId = BigInt(process.env.CHAIN_ID!);
const rpcUrl = process.env.AUDIT_RPC_URL ?? process.env.EVM_RPC_URL!;
process.env.EVM_RPC_URL = rpcUrl;
const rpc = createPublicClient({ transport: http(rpcUrl, { retryCount: 4 }) });
const filters = logStreamFilters(createEvmProcessors());
const dao = DAO.create(process.env.PG_CONNECTION_STRING!, chainId);
const adapter = createEvmAdapter(
  rpc,
  filters,
  Number.MAX_SAFE_INTEGER,
  (source) => dao.loadDiscoveredAddresses(source),
);
const entrypoint = await createEvmEntrypoint(chainId);

class DryRun extends Error {}
const report = (line: Record<string, unknown>) =>
  console.log(JSON.stringify(line));

const finalized = await adapter.fetchFinalized();
if (!finalized) throw new Error("Could not read the finalized block");

let failed = false;
for (const blockNumber of blockNumbers) {
  if (blockNumber > finalized.number) {
    throw new Error(
      `Block ${blockNumber} is not finalized (finalized: ${finalized.number})`,
    );
  }
  const header = await adapter.fetchBlock(blockNumber);
  if (!header) throw new Error(`Could not read block ${blockNumber}`);
  const [block] = await adapter.readRange(blockNumber, blockNumber);
  if (!block) {
    report({
      block: blockNumber,
      result: "no matching events on chain; nothing to do",
    });
    continue;
  }
  if (BigInt(block.header.blockHash) !== BigInt(header.hash)) {
    throw new Error(
      `Block ${blockNumber}: logs name ${block.header.blockHash}, header is ${header.hash}`,
    );
  }
  await adapter.completeFresh([block], header);

  const result: Record<string, unknown> = {
    block: blockNumber,
    hash: header.hash,
    apply,
  };
  try {
    await dao.begin(async (tx) => {
      const existing = await tx.loadStoredBlockHashes(blockNumber, blockNumber);
      if (existing.size > 0)
        throw new Error(`Block ${blockNumber} is already stored`);

      const before = await tx.poolStatesSnapshot();
      const numEvents = entrypoint.getPlannedEvents(block);
      await tx.insertBlock({
        number: blockNumber,
        hash: BigInt(header.hash),
        time: header.timestamp,
        baseFeePerGas: header.baseFeePerGas,
        numEvents,
      });
      result.eventsProcessed = await entrypoint.processBlock({
        block,
        blockNumber,
        dao: tx,
      });
      result.plannedEvents = numEvents;
      result.refreshedPools = await tx.refreshPoolStatesSwappedIn(blockNumber);
      result.rows = await tx.rowsReferencingBlock(blockNumber);

      const after = await tx.poolStatesSnapshot();
      const changed = [...new Set([...before.keys(), ...after.keys()])]
        .filter((id) => before.get(id) !== after.get(id))
        .map((id) => ({
          pool: id,
          before: before.get(id),
          after: after.get(id),
        }));
      result.poolStateChanges = changed;
      if (changed.length > 0) {
        throw new Error(
          `Block ${blockNumber} would change current pool state; refusing: ${JSON.stringify(changed)}`,
        );
      }
      if (!apply) throw new DryRun();
    });
    result.result = "committed";
  } catch (error) {
    if (error instanceof DryRun) {
      result.result = "dry run, rolled back";
    } else {
      failed = true;
      result.result = "failed, rolled back";
      result.error = error instanceof Error ? error.message : String(error);
    }
  }
  report(result);
}

await dao.end();
process.exit(failed ? 1 : 0);
