import { describe, expect, it } from "vitest";
import { run } from "../src/engine.js";
import type { Assumptions, Plan } from "../src/model.js";

describe("normalizePlan assumptions defaults", () => {
  it("fills omitted Assumptions fields so run() never produces NaN", () => {
    const plan: Plan = {
      birth_year: 1990,
      accounts: [{ name: "cash", tax: "cash", balance: 1000 }],
      incomes: [],
      social_security: [],
      expenses: [],
      contributions: [],
      house: null,
      // Deliberately partial: only start_year/end_year set, everything else
      // (inflation, ret, dividend_rate, income_tax, ... retirement_year,
      // coast_multiple, fi_multiple) is a legitimate Python-side default per
      // model.py's Assumptions dataclass. Cast to bypass the TS required-field
      // check, mirroring a plan JSON that simply omits those keys.
      assumptions: { start_year: 2026, end_year: 2027 } as Assumptions,
    };

    const rows = run(plan);

    expect(rows.length).toBe(2);
    for (const row of rows) {
      for (const k of ["year", "net_worth", "liquid_net_worth", "income",
                       "expenses", "taxes", "withdrawals", "contributions"] as const) {
        expect(Number.isFinite(row[k]), `${k} should be finite, got ${row[k]}`).toBe(true);
      }
    }
  });
});
