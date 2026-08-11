import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "../src/engine.js";
import type { Plan } from "../src/model.js";

const planPath = process.env.COVE_FI_PRIVATE_PLAN; // private/plan_aj.json
const rowsPath = process.env.COVE_FI_PRIVATE_ROWS; // private/rows_aj.json

describe.skipIf(!planPath || !rowsPath)("parity vs Python reference", () => {
  it("reproduces every row within $1", () => {
    const plan = JSON.parse(readFileSync(planPath!, "utf8")) as Plan;
    const expected = JSON.parse(readFileSync(rowsPath!, "utf8")) as Record<string, number>[];
    const rows = run(plan);
    expect(rows.length).toBe(expected.length);
    for (let i = 0; i < rows.length; i++) {
      const got = rows[i]! as unknown as Record<string, number>;
      for (const k of ["year", "net_worth", "liquid_net_worth", "income",
                       "expenses", "taxes", "withdrawals", "contributions"]) {
        expect.soft(Math.abs(got[k]! - expected[i]![k]!),
          `year ${expected[i]!.year} ${k}`).toBeLessThan(1);
      }
    }
  });
});
