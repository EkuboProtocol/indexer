import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient, ensureIndexerCursor } from "../helpers/db.js";

// AuctionPositions (evm-contracts PR #378) is an ERC721 whose token ids are
// uint192 and whose core position salt is bytes24(uint192(id)), i.e. the id
// itself. It is its own locker and has no nft_locker_mappings row. A burn is a
// Transfer to 0, and the original minter can mint the same id again. These
// tests pin that the existing NFT/position schema already handles that shape:
// ownership follows the latest Transfer, and every range stays attached to
// the id across burn and re-mint because ranges are keyed by (locker, salt),
// never by owner.

const CHAIN_ID = 31337;
const AUCTION_POSITIONS = BigInt("0x00000000000000000000000000000000a0c7105e");
const ALICE = 0xa11cen;
const BOB = 0xb0bn;
// A realistic uint192 id: saltToId truncates keccak(minter, salt) to 192 bits.
const TOKEN_ID = (1n << 191n) + 0x1234n;

// The query behind GET /positions/{chainId}/{positionsAddress}/{tokenId}/ranges
// in the api repo (listPositionRanges in src/queries.ts). Keep the two in step.
const RANGES_QUERY = `
WITH target AS (SELECT COALESCE(nlm.locker, $2::NUMERIC)                  AS locker,
                       nft_token_salt(nlm.token_id_transform, $3::NUMERIC) AS salt
                FROM (SELECT 1) AS one
                         LEFT JOIN nft_locker_mappings nlm
                                   ON nlm.chain_id = $1 AND nlm.nft_address = $2::NUMERIC)
SELECT pk.token0,
       pk.token1,
       pk.fee,
       pk.tick_spacing,
       pk.pool_extension AS extension,
       pk.stableswap_center_tick,
       pk.stableswap_amplification,
       pcl.lower_bound,
       pcl.upper_bound,
       pcl.liquidity
FROM target
         JOIN position_current_liquidity pcl
              ON pcl.locker = target.locker AND pcl.salt = target.salt
         JOIN pool_keys pk ON pk.pool_key_id = pcl.pool_key_id
WHERE pk.chain_id = $1
ORDER BY pk.pool_key_id, pcl.lower_bound, pcl.upper_bound`;

let client: PGlite;
let poolKeyId: bigint;
let nextBlock = 100;

beforeAll(async () => {
  client = await createClient();
  await ensureIndexerCursor(client, CHAIN_ID);
  const {
    rows: [row],
  } = await client.query<{ pool_key_id: bigint }>(
    `INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee,
                            fee_denominator, tick_spacing, pool_extension)
     VALUES ($1, 1000, 2000, 1, 2, 0, 18446744073709551616, 1, 5000)
     RETURNING pool_key_id`,
    [CHAIN_ID],
  );
  poolKeyId = row!.pool_key_id;
});

afterAll(async () => {
  await client.close();
});

async function newBlock() {
  const blockNumber = nextBlock++;
  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
     VALUES ($1, $2, $3, $4, 0)`,
    [CHAIN_ID, blockNumber, blockNumber.toString(), new Date(blockNumber * 1000)],
  );
  return blockNumber;
}

async function transfer(from: bigint, to: bigint) {
  const blockNumber = await newBlock();
  await client.query(
    `INSERT INTO nonfungible_token_transfers (chain_id, block_number, transaction_index,
                                              event_index, transaction_hash, emitter,
                                              token_id, from_address, to_address)
     VALUES ($1, $2, 0, 0, $3, $4, $5, $6, $7)`,
    [
      CHAIN_ID,
      blockNumber,
      blockNumber.toString(),
      AUCTION_POSITIONS.toString(),
      TOKEN_ID.toString(),
      from.toString(),
      to.toString(),
    ],
  );
}

async function updatePosition(lower: number, upper: number, delta: bigint) {
  const blockNumber = await newBlock();
  await client.query(
    `INSERT INTO position_updates (chain_id, block_number, transaction_index, event_index,
                                   transaction_hash, emitter, pool_key_id, locker, salt,
                                   lower_bound, upper_bound, liquidity_delta, delta0, delta1)
     VALUES ($1, $2, 0, 0, $3, 1000, $4, $5, $6, $7, $8, $9, 0, 0)`,
    [
      CHAIN_ID,
      blockNumber,
      blockNumber.toString(),
      poolKeyId.toString(),
      AUCTION_POSITIONS.toString(),
      TOKEN_ID.toString(),
      lower,
      upper,
      delta.toString(),
    ],
  );
}

async function ranges() {
  const { rows } = await client.query<{
    lower_bound: number;
    upper_bound: number;
    liquidity: string;
  }>(RANGES_QUERY, [CHAIN_ID, AUCTION_POSITIONS.toString(), TOKEN_ID.toString()]);
  return rows.map((r) => [r.lower_bound, r.upper_bound, r.liquidity]);
}

// Mirrors the owner filter of getPositionsByAddress in the api repo.
async function ownerRows(owner: bigint, state: "opened" | "all") {
  const { rows } = await client.query<{
    current_owner: string;
    lower_bound: number;
    upper_bound: number;
    liquidity: string;
  }>(
    `SELECT current_owner, lower_bound, upper_bound, liquidity
     FROM nonfungible_token_positions_view
     WHERE chain_id = $1
       AND nft_address = $2
       AND ${
         state === "opened"
           ? "liquidity != 0 AND current_owner = $3"
           : "(current_owner = $3 OR previous_owner = $3)"
       }
     ORDER BY lower_bound, upper_bound`,
    [CHAIN_ID, AUCTION_POSITIONS.toString(), owner.toString()],
  );
  return rows.map((r) => [
    BigInt(r.current_owner),
    r.lower_bound,
    r.upper_bound,
    r.liquidity,
  ]);
}

test("ranges and ownership follow an AuctionPositions id across burn and re-mint", async () => {
  // Alice mints and deposits into two ranges of the same pool.
  await transfer(0n, ALICE);
  await updatePosition(-100, 100, 500n);
  await updatePosition(-200, 200, 700n);

  expect(await ranges()).toEqual([
    [-200, 200, "700"],
    [-100, 100, "500"],
  ]);
  expect(await ownerRows(ALICE, "opened")).toEqual([
    [ALICE, -200, 200, "700"],
    [ALICE, -100, 100, "500"],
  ]);

  // She withdraws everything and burns: every range is still listed, at zero,
  // and the owner listing no longer reports her as holding an open position.
  await updatePosition(-100, 100, -500n);
  await updatePosition(-200, 200, -700n);
  await transfer(ALICE, 0n);

  expect(await ranges()).toEqual([
    [-200, 200, "0"],
    [-100, 100, "0"],
  ]);
  expect(await ownerRows(ALICE, "opened")).toEqual([]);
  expect(await ownerRows(ALICE, "all")).toEqual([
    [0n, -200, 200, "0"],
    [0n, -100, 100, "0"],
  ]);

  // She re-mints the same id and deposits into a third range. The old ranges
  // are still attached to the id, and ownership is hers again.
  await transfer(0n, ALICE);
  await updatePosition(-100, 100, 300n);
  await updatePosition(-50, 50, 900n);

  expect(await ranges()).toEqual([
    [-200, 200, "0"],
    [-100, 100, "300"],
    [-50, 50, "900"],
  ]);
  expect(await ownerRows(ALICE, "opened")).toEqual([
    [ALICE, -100, 100, "300"],
    [ALICE, -50, 50, "900"],
  ]);

  // Ownership then follows the latest Transfer; the ranges do not move.
  await transfer(ALICE, BOB);
  expect(await ownerRows(BOB, "opened")).toEqual([
    [BOB, -100, 100, "300"],
    [BOB, -50, 50, "900"],
  ]);
  expect(await ownerRows(ALICE, "opened")).toEqual([]);
  expect(await ranges()).toHaveLength(3);
});

test("ranges resolve a mapped Positions NFT to its locker and salt transform", async () => {
  // The route also serves ordinary Positions contracts, whose token ids are
  // reduced to their low 192 bits through nft_locker_mappings.
  const nft = 0xabcdefn;
  const tokenId = (1n << 200n) + TOKEN_ID;
  await client.query(
    `INSERT INTO nft_locker_mappings (chain_id, nft_address, locker, token_id_transform)
     VALUES ($1, $2, $3, JSONB_BUILD_OBJECT('bit_mod', 192))`,
    [CHAIN_ID, nft.toString(), AUCTION_POSITIONS.toString()],
  );
  const { rows } = await client.query(RANGES_QUERY, [
    CHAIN_ID,
    nft.toString(),
    tokenId.toString(),
  ]);
  expect(rows).toHaveLength(3);

  const { rows: none } = await client.query(RANGES_QUERY, [
    CHAIN_ID,
    AUCTION_POSITIONS.toString(),
    (TOKEN_ID + 1n).toString(),
  ]);
  expect(none).toEqual([]);
});
