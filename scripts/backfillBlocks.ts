/**
 * Indexes individual finalized blocks the stream skipped, without moving the
 * cursor. Found by `scripts/auditEventGaps.ts`; see EKU-272.
 *
 *   NETWORK=mainnet PG_CONNECTION_STRING=<url> AUDIT_RPC_URL=<url> \
 *     bun scripts/backfillBlocks.ts <block> [block...] [--apply]
 *
 * Dry run by default: everything happens inside a transaction that is then
 * rolled back, and the report says what would have been written. `--apply`
 * commits.
 *
 * Each block goes through the same processors and DAO the runtime uses, in one
 * transaction per block, and then repairs the one piece of derived state that
 * assumes events arrive in order: `on_insert_swap` overwrites `pool_states`
 * with the inserted swap's after-state, which for a block below the head is a
 * stale state. Touched pools are recomputed from full history, and the run
 * fails if any pool state differs from before -- unless the backfilled swap is
 * genuinely that pool's latest event, which is reported.
 *
 * Every other trigger on these tables is an order-independent upsert (hourly
 * volume, fees and TVL deltas, pool TVL) or a GREATEST (oracle), so the
 * aggregates correct themselves in the same transaction.
 *
 * Reversal is the path every reorg takes:
 *   DELETE FROM blocks WHERE chain_id = <chain> AND block_number = <block>;
 * cascades to every event row and runs the same triggers in reverse.
 */
import { createPublicClient, http } from "viem";
import { loadConfig } from "../src/config";
import { DAO } from "../src/_shared/dao";
import { createEvmEntrypoint, createEvmProcessors } from "../src/evm";
import { createEvmAdapter, type LogStreamFilter } from "../src/evm/logStream";

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
const filters: LogStreamFilter[] = createEvmProcessors().map((processor, ix) => ({
  id: ix + 1,
  address: processor.address,
  topics: processor.filter.topics,
  strict: processor.filter.strict,
}));
const adapter = createEvmAdapter(rpc, filters, Number.MAX_SAFE_INTEGER);
const entrypoint = await createEvmEntrypoint(chainId);
const dao = DAO.create(process.env.PG_CONNECTION_STRING!, chainId);

class DryRun extends Error {}
const report = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

const finalized = await adapter.fetchFinalized();
if (!finalized) throw new Error("Could not read the finalized block");

let failed = false;
for (const blockNumber of blockNumbers) {
  if (blockNumber > finalized.number) {
    throw new Error(`Block ${blockNumber} is not finalized (finalized: ${finalized.number})`);
  }
  const header = await adapter.fetchBlock(blockNumber);
  if (!header) throw new Error(`Could not read block ${blockNumber}`);
  const [block] = await adapter.readRange(blockNumber, blockNumber);
  if (!block) {
    report({ block: blockNumber, result: "no matching events on chain; nothing to do" });
    continue;
  }
  if (BigInt(block.header.blockHash) !== BigInt(header.hash)) {
    throw new Error(`Block ${blockNumber}: logs name ${block.header.blockHash}, header is ${header.hash}`);
  }
  await adapter.completeFresh([block], header);

  const result: Record<string, unknown> = { block: blockNumber, hash: header.hash, apply };
  try {
    await dao.begin(async (tx) => {
      const existing = await tx.loadStoredBlockHashes(blockNumber, blockNumber);
      if (existing.size > 0) throw new Error(`Block ${blockNumber} is already stored`);

      const before = await tx.poolStatesSnapshot();
      const numEvents = entrypoint.getPlannedEvents(block);
      await tx.insertBlock({
        number: blockNumber,
        hash: BigInt(header.hash),
        time: header.timestamp,
        baseFeePerGas: header.baseFeePerGas,
        numEvents,
      });
      result.eventsProcessed = await entrypoint.processBlock({ block, blockNumber, dao: tx });
      result.plannedEvents = numEvents;
      result.refreshedPools = await tx.refreshPoolStatesSwappedIn(blockNumber);
      result.rows = await tx.rowsReferencingBlock(blockNumber);

      const after = await tx.poolStatesSnapshot();
      const changed = [...new Set([...before.keys(), ...after.keys()])]
        .filter((id) => before.get(id) !== after.get(id))
        .map((id) => ({ pool: id, before: before.get(id), after: after.get(id) }));
      result.poolStateChanges = changed;
      if (changed.length > 0) {
        throw new Error(`Block ${blockNumber} would change current pool state; refusing: ${JSON.stringify(changed)}`);
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
