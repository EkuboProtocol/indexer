import type { DAO, IndexerCursor } from "../../src/_shared/dao";

// Compile-only contracts, checked by the repository's TypeScript project.
export async function verifyTransactionReturnTypes(dao: DAO) {
  const scalar: number = await dao.begin(() => 1);
  const asynchronous: string = await dao.begin(async () => "value");
  const cursor: IndexerCursor | null = await dao.begin((tx) => tx.loadCursor());
  const tuple: [number, string] = await dao.begin(
    () => [Promise.resolve(1), Promise.resolve("two")] as const,
  );
  const values: number[] = await dao.begin(() => [Promise.resolve(1)]);
  // @ts-expect-error Scalar results retain their type.
  const invalidScalar: string = await dao.begin(() => 1);
  // @ts-expect-error Async results retain their type.
  const invalidAsync: number = await dao.begin(async () => "value");
  // @ts-expect-error Loading a cursor does not return a scalar.
  const invalidCursor: number = await dao.begin((tx) => tx.loadCursor());
  // @ts-expect-error Tuple positions retain their individual resolved types.
  const invalidTuple: [string, number] = await dao.begin(
    () => [Promise.resolve(1), Promise.resolve("two")] as const,
  );
  // @ts-expect-error Promise arrays resolve to arrays of the original element type.
  const invalidArray: string[] = await dao.begin(() => [Promise.resolve(1)]);
  return {
    scalar,
    asynchronous,
    cursor,
    tuple,
    values,
    invalidScalar,
    invalidAsync,
    invalidCursor,
    invalidTuple,
    invalidArray,
  };
}
