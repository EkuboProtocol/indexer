import { DAO } from "../../src/_shared/dao";

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
