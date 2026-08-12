import { describe, expect, it } from "vitest";
import { run } from "../../src/engine.js";
import type { Plan } from "../../src/model.js";
import { syntheticPlan } from "../helpers/synthetic.js";

const terminal = (p: Plan, over = {}) => run(p, over).at(-1)!;

// Reconciliation: at the plan's default end_year (2091), synthetic's liquid
// assets are already fully depleted for BOTH the 6% and 8% (and the
// base-vs-bumped-expense) scenarios well before the horizon ends — original
// depletes ~2072, ret=0.06 depletes ~2065, bumped-expenses depletes almost
// immediately. Once liquid_net_worth pins at 0, net_worth is just the
// (already-paid-off) house's deterministic appreciation trajectory, which
// doesn't depend on ret or expenses — so terminal(...).net_worth at 2091 is
// IDENTICAL across scenarios (verified: 3747549.633745438 both sides) and
// the brief's assertions as written fail on a floor-convergence artifact,
// not an engine defect.
//
// An initial fix used end_year=2058, but that's not actually safe for the
// expense sub-test: bumped-expenses' liquid_net_worth is 91,276 at 2057 and
// exactly 0 at 2058 — i.e. it depletes AT 2058, not "comfortably before" it.
// Probed liquid_net_worth at 2050 for all four compared scenarios instead —
// all have genuine, large headroom there:
//   ret=0.08 -> 2,154,832   ret=0.06 -> 1,453,052
//   orig     -> 1,768,818   bumped   ->   971,049
// (next-closest scenario to depleting, bumped, still clears 100k by ~9.7x).
// 2050 is also synthetic's own retirement_year, so it's the first
// withdrawal year rather than an arbitrary accumulation-phase snapshot.
const EARLY_HORIZON = { end_year: 2050 };

describe("monotonicity", () => {
  it("higher return -> higher terminal NW", () => {
    expect(terminal(syntheticPlan(), { ret: 0.08, ...EARLY_HORIZON }).net_worth).toBeGreaterThan(
      terminal(syntheticPlan(), { ret: 0.06, ...EARLY_HORIZON }).net_worth,
    );
  });
  it("later retirement -> depletion no earlier", () => {
    const dep = (over: object) => {
      const rows = run(syntheticPlan(), over);
      const p = syntheticPlan().assumptions;
      const hit = rows.find((r) => r.year >= (over as any).retirement_year && r.liquid_net_worth <= 0);
      return hit ? hit.year : p.end_year + 1;
    };
    expect(dep({ retirement_year: 2052 })).toBeGreaterThanOrEqual(dep({ retirement_year: 2046 }));
  });
  it("higher expenses -> lower terminal NW", () => {
    const p = syntheticPlan();
    // synthetic's base-living expense is named "base" (test/helpers/synthetic.ts), not "base living"
    const bumped: Plan = {
      ...p,
      expenses: p.expenses.map((e) => (e.name === "base" ? { ...e, amount: e.amount * 1.2 } : e)),
    };
    expect(terminal(bumped, EARLY_HORIZON).net_worth).toBeLessThan(terminal(p, EARLY_HORIZON).net_worth);
  });
});
