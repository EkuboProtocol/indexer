import { DAO } from "../../src/_shared/dao";
import assert from "node:assert/strict";

const dao = DAO.create(process.env.TEST_PG_CONNECTION_STRING!, 1n);
const hash = (1n << 255n) + 123n;
const time = new Date("2026-11-02T00:00:00.000Z");
const cursor = { orderKey: 100n, uniqueKey: `0x${hash.toString(16)}` as const };

await dao.acquireLock();
switch (process.argv[2]) {
  case "commit":
    await dao.begin(async (transaction) => {
      await transaction.insertBlock({
        number: 100,
        hash,
        time,
        baseFeePerGas: null,
        numEvents: 1,
      });
      await transaction.writeCursor(
        cursor,
        { orderKey: 0n },
        {
          number: 100,
          hash,
          time,
          baseFeePerGas: 12345678901234567890n,
        },
      );
    });
    break;
  case "rollback":
    try {
      await dao.begin(async (transaction) => {
        await transaction.insertBlock({
          number: 101,
          hash: hash + 1n,
          time,
          baseFeePerGas: null,
          numEvents: 1,
        });
        await transaction.writeCursor({ orderKey: 101n }, cursor);
        throw new Error("fixture rollback");
      });
      throw new Error("transaction unexpectedly committed");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "fixture rollback") {
        throw error;
      }
    }
    break;
  case "read":
    break;
  case "contract":
    await verifyTransactionContract();
    break;
  default:
    throw new Error("unknown fixture action");
}
console.log(
  JSON.stringify(await dao.loadCursor(), (_, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  ),
);
// Deliberately exit without releasing the advisory lock or closing the pool:
// the next process must recover the durable cursor after an abrupt worker exit.
process.exit(0);

async function verifyTransactionContract() {
  assert.equal(await dao.begin(() => 7), 7);
  assert.equal(await dao.begin(async () => "value"), "value");
  assert.deepEqual(
    await dao.begin(
      () => [Promise.resolve(1), Promise.resolve("two")] as const,
    ),
    [1, "two"],
  );
  assert.deepEqual(await dao.begin(() => [Promise.resolve(1)]), [1]);
  let nestedCalled = false;
  await dao.begin(async (transaction) => {
    await assert.rejects(
      transaction.begin(() => {
        nestedCalled = true;
        return "nested";
      }),
      {
        name: "Error",
        message: "Cannot begin a transaction inside a transaction",
      },
    );
    assert.equal(nestedCalled, false);
    await assert.rejects(transaction.end(), {
      name: "Error",
      message: "Cannot end the connection from inside a transaction",
    });
    // Rejection must leave the outer transaction usable, not aborted.
    assert.deepEqual(await transaction.loadCursor(), cursor);
    await transaction.writeCursor(cursor, cursor, {
      number: 100,
      hash,
      time,
      baseFeePerGas: 12345678901234567890n,
    });
  });
  await verifyRollback();
}

async function verifyRollback() {
  const marker = new Error("original callback failure");
  await assert.rejects(
    dao.begin(async (transaction) => {
      await transaction.insertBlock({
        number: 101,
        hash: hash + 1n,
        time,
        baseFeePerGas: null,
        numEvents: 1,
      });
      await transaction.writeCursor({ orderKey: 101n }, cursor);
      assert.deepEqual(await transaction.loadCursor(), { orderKey: 101n });
      throw marker;
    }),
    (error: unknown) => error === marker,
  );
  assert.deepEqual(await dao.loadCursor(), cursor);
  assert.deepEqual(
    await dao.begin((transaction) => transaction.loadCursor()),
    cursor,
  );
}
