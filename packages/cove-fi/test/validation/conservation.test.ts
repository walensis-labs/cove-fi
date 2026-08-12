import { describe, expect, it } from "vitest";
import { run } from "../../src/engine.js";
import { syntheticPlan } from "../helpers/synthetic.js";

describe("conservation & properties", () => {
  const plan = syntheticPlan();
  const rows = run(plan);
  it("working years: income >= taxes + contributions + (expenses - unfunded deficit)", () => {
    for (const r of rows.filter((r) => r.year < plan.assumptions.retirement_year)) {
      const resid = r.income - r.taxes - r.contributions - r.expenses;
      expect(resid, `year ${r.year}`).toBeLessThan(1); // surplus always spent
      expect(resid, `year ${r.year}`).toBeGreaterThan(-25_000); // bounded deficit wedge
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
