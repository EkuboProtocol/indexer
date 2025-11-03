import { beforeAll, afterAll, expect, test } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const MIGRATION_FILES = [
  "001_chain_tables.sql",
  "002_core_tables.sql",
  "003_nonfungible_tokens.sql",
] as const;

let client: PGlite;

beforeAll(async () => {
  client = await createClient({ files: [...MIGRATION_FILES] });
});

afterAll(async () => {
  await client.close();
});

async function seedBlock(client: PGlite, chainId: number) {
  const blockNumber = 500;
  const blockHash = "9001";
  const blockTime = new Date("2024-02-01T00:00:00Z");

  await client.query(
    `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
     VALUES ($1, $2, $3, $4)`,
    [chainId, blockNumber, blockHash, blockTime]
  );

  return { chainId, blockNumber };
}

async function insertTransfer({
  chainId,
  blockNumber,
  transactionIndex,
  eventIndex,
  emitter,
  tokenId,
  fromAddress,
  toAddress,
}: {
  chainId: number;
  blockNumber: number;
  transactionIndex: number;
  eventIndex: number;
  emitter: string;
  tokenId: string;
  fromAddress: string;
  toAddress: string;
}) {
  const {
    rows: [{ event_id: eventId }],
  } = await client.query<{ event_id: bigint }>(
    `INSERT INTO nonfungible_token_transfers (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        token_id,
        from_address,
        to_address
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING event_id`,
    [
      chainId,
      blockNumber,
      transactionIndex,
      eventIndex,
      `${blockNumber}${transactionIndex}${eventIndex}`,
      emitter,
      tokenId,
      fromAddress,
      toAddress,
    ]
  );

  return eventId;
}

test("inserting transfers updates nonfungible_token_owners", async () => {
  const { chainId, blockNumber } = await seedBlock(client, 11);
  const emitter = "12345";
  const tokenId = "67890";

  const firstEventId = await insertTransfer({
    chainId,
    blockNumber,
    transactionIndex: 0,
    eventIndex: 0,
    emitter,
    tokenId,
    fromAddress: "100",
    toAddress: "200",
  });

  const { rows: firstOwnerRows } = await client.query(
    `SELECT last_transfer_event_id, current_owner, previous_owner
     FROM nonfungible_token_owners
     WHERE chain_id = $1 AND nft_address = $2 AND token_id = $3`,
    [chainId, emitter, tokenId]
  );

  expect(firstOwnerRows.length).toBe(1);
  expect(firstOwnerRows[0]).toMatchObject({
    last_transfer_event_id: firstEventId,
    current_owner: "200",
    previous_owner: "100",
  });

  const secondEventId = await insertTransfer({
    chainId,
    blockNumber,
    transactionIndex: 0,
    eventIndex: 1,
    emitter,
    tokenId,
    fromAddress: "200",
    toAddress: "300",
  });

  const { rows: secondOwnerRows } = await client.query(
    `SELECT last_transfer_event_id, current_owner, previous_owner
     FROM nonfungible_token_owners
     WHERE chain_id = $1 AND nft_address = $2 AND token_id = $3`,
    [chainId, emitter, tokenId]
  );

  expect(secondOwnerRows.length).toBe(1);
  expect(secondOwnerRows[0]).toMatchObject({
    last_transfer_event_id: secondEventId,
    current_owner: "300",
    previous_owner: "200",
  });
});

test("deleting transfers rewinds and removes owner records", async () => {
  const { chainId, blockNumber } = await seedBlock(client, 12);
  const emitter = "54321";
  const tokenId = "98765";

  const firstEventId = await insertTransfer({
    chainId,
    blockNumber,
    transactionIndex: 1,
    eventIndex: 0,
    emitter,
    tokenId,
    fromAddress: "400",
    toAddress: "500",
  });

  const secondEventId = await insertTransfer({
    chainId,
    blockNumber,
    transactionIndex: 1,
    eventIndex: 1,
    emitter,
    tokenId,
    fromAddress: "500",
    toAddress: "600",
  });

  await client.query(
    `DELETE FROM nonfungible_token_transfers WHERE chain_id = $1 AND event_id = $2`,
    [chainId, secondEventId.toString()]
  );

  const { rows: rewindRows } = await client.query(
    `SELECT last_transfer_event_id, current_owner, previous_owner
     FROM nonfungible_token_owners
     WHERE chain_id = $1 AND nft_address = $2 AND token_id = $3`,
    [chainId, emitter, tokenId]
  );

  expect(rewindRows.length).toBe(1);
  expect(rewindRows[0]).toMatchObject({
    last_transfer_event_id: firstEventId,
    current_owner: "500",
    previous_owner: "400",
  });

  await client.query(
    `DELETE FROM nonfungible_token_transfers WHERE chain_id = $1 AND event_id = $2`,
    [chainId, firstEventId.toString()]
  );

  const { rows: emptyRows } = await client.query(
    `SELECT 1 FROM nonfungible_token_owners WHERE chain_id = $1 AND nft_address = $2 AND token_id = $3`,
    [chainId, emitter, tokenId]
  );

  expect(emptyRows.length).toBe(0);
});
