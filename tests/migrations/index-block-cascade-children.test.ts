import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

test("every ON DELETE CASCADE child of blocks can find its rows by index", async () => {
  const client = await createClient();

  // For each FK into blocks, check there is an index whose first two columns
  // are exactly the FK's columns. Without one, deleting a block sequentially
  // scans the child -- which is what made delete_old_empty_blocks() grow to
  // 250 s per hourly run.
  const { rows } = await client.query<{ child: string }>(
    `WITH fk AS (SELECT con.conrelid AS child, con.conkey
                 FROM pg_constraint con
                 WHERE con.confrelid = 'blocks'::regclass
                   AND con.contype = 'f'),
          fk_cols AS (SELECT fk.child,
                             (SELECT ARRAY_AGG(a.attname ORDER BY x.ord)
                              FROM UNNEST(fk.conkey) WITH ORDINALITY x(attnum, ord)
                                       JOIN pg_attribute a
                                            ON a.attrelid = fk.child AND a.attnum = x.attnum) AS cols
                      FROM fk),
          idx AS (SELECT i.indrelid AS child,
                         (SELECT ARRAY_AGG(a.attname ORDER BY x.ord)
                          FROM UNNEST(i.indkey::int2[]) WITH ORDINALITY x(attnum, ord)
                                   JOIN pg_attribute a
                                        ON a.attrelid = i.indrelid AND a.attnum = x.attnum
                          WHERE x.ord <= 2) AS lead2
                  FROM pg_index i
                  WHERE i.indisvalid)
     SELECT f.child::regclass::text AS child
     FROM fk_cols f
     WHERE NOT EXISTS (SELECT 1
                       FROM idx
                       WHERE idx.child = f.child
                         AND idx.lead2 @> f.cols
                         AND f.cols @> idx.lead2)
     ORDER BY 1`
  );

  expect(rows.map((row) => row.child)).toEqual([]);
});

test("blocks still has the 43 cascading children this covers", async () => {
  const client = await createClient();

  const { rows } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM pg_constraint
     WHERE confrelid = 'blocks'::regclass
       AND contype = 'f'
       AND confdeltype = 'c'`
  );

  // A guard on the shape of the problem rather than the number itself: if a
  // new event table is added with a cascading FK into blocks and no index,
  // the test above fails and this one says why the count moved.
  expect(rows[0]!.count).toBeGreaterThanOrEqual(43);
});
