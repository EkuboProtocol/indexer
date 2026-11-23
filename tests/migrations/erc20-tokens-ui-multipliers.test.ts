import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "../helpers/db.js";

const E18 = "1000000000000000000";

describe("00141 erc20_tokens_ui_multipliers", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = await createClient({
      files: ["00018_tokens", "00141_erc20_tokens_ui_multipliers"],
    });
  });

  afterAll(async () => {
    await client.close();
  });

  async function effective(
    ui: string,
    next: string | null,
    effectiveAt: string | null,
    at: string,
  ): Promise<string> {
    const {
      rows: [row],
    } = await client.query<{ value: string }>(
      `SELECT erc20_token_effective_ui_multiplier($1::NUMERIC, $2::NUMERIC, $3::NUMERIC, $4::TIMESTAMPTZ)::TEXT AS value`,
      [ui, next, effectiveAt, at],
    );
    return row?.value ?? "";
  }

  // 1795185000 is 2026-11-20 14:30:00 UTC, SNDK's 8x split.
  test("the current multiplier applies before effectiveAt", async () => {
    expect(
      await effective(
        E18,
        `8${E18.slice(1)}`,
        "1795185000",
        "2026-11-20T14:29:59Z",
      ),
    ).toBe(E18);
  });

  test("the new multiplier applies from effectiveAt on", async () => {
    expect(
      await effective(
        E18,
        `8${E18.slice(1)}`,
        "1795185000",
        "2026-11-20T14:30:00Z",
      ),
    ).toBe(`8${E18.slice(1)}`);
    expect(
      await effective(
        E18,
        `8${E18.slice(1)}`,
        "1795185000",
        "2026-11-21T00:00:00Z",
      ),
    ).toBe(`8${E18.slice(1)}`);
  });

  test("no schedule, or a zero one, keeps the current multiplier", async () => {
    expect(
      await effective(
        "1001352514631277880",
        null,
        null,
        "2030-01-01T00:00:00Z",
      ),
    ).toBe("1001352514631277880");
    expect(await effective(E18, "0", "0", "2030-01-01T00:00:00Z")).toBe(E18);
  });

  test("the view reads the effective value now, and a zero multiplier is refused", async () => {
    await client.query(
      `INSERT INTO erc20_tokens_ui_multipliers
         (chain_id, token_address, ui_multiplier, new_ui_multiplier, effective_at, checked_at)
       VALUES (4663, 1, $1, $2, 1795185000, NOW()),
              (4663, 2, $1, $2, 99999999999, NOW())`,
      [E18, `4${E18.slice(1)}`],
    );
    const { rows } = await client.query<{
      token_address: string;
      ui_multiplier: string;
    }>(
      `SELECT token_address::TEXT, ui_multiplier::TEXT
       FROM erc20_tokens_effective_ui_multipliers
       ORDER BY token_address`,
    );
    expect(rows).toEqual([
      { token_address: "1", ui_multiplier: `4${E18.slice(1)}` },
      { token_address: "2", ui_multiplier: E18 },
    ]);

    expect(
      client.query(
        `INSERT INTO erc20_tokens_ui_multipliers (chain_id, token_address, ui_multiplier, checked_at)
         VALUES (4663, 3, 0, NOW())`,
      ),
    ).rejects.toThrow();
  });
});
