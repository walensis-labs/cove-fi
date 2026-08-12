import { describe, expect, it } from "vitest";
import { run } from "../../src/engine.js";
import { syntheticPlan } from "../helpers/synthetic.js";

describe("conservation & properties", () => {
  const plan = syntheticPlan();
  const rows = run(plan);
  // Canonical home for the working-years cash-flow identity (both sides).
  // engine-conventions.test.ts asserts only the one-sided surplus-spent
  // guarantee and points back here for the negative-side bound — keep this
  // as the single source of truth for both directions.
  it("working years: income >= taxes + contributions + (expenses - unfunded deficit)", () => {
    for (const r of rows.filter((r) => r.year < plan.assumptions.retirement_year)) {
      const resid = r.income - r.taxes - r.contributions - r.expenses;
      // positive side: surplus is always spent (cashFlowDefault: "spend"),
      // so income - taxes - contributions - expenses never exceeds ~0.
      expect(resid, `year ${r.year}`).toBeLessThan(1);
      // negative side: working-year deficits come from timing wedges where
      // a one-time expense outruns available cash flow before contribution
      // rungs clamp to 0 — synthetic's 2035 nominal_at_start "car" expense
      // ($25k) is the sole trigger here. Observed worst case across all
      // working years: resid = -18,342.253516408848 in 2035. -20,000 bounds
      // that with headroom while still catching a genuine regression.
      expect(resid, `year ${r.year}`).toBeGreaterThan(-20_000);
    }
  });
  it("no NaN/Infinity anywhere", () => {
    for (const r of rows)
      for (const v of Object.values(r)) expect(Number.isFinite(v)).toBe(true);
  });
  it("deterministic", () => {
    expect(run(syntheticPlan())).toEqual(rows);
  });
});
