import { describe, expect, it } from "vitest";
import { run, type YearRates } from "../src/engine.js";
import { DEFAULT_ASSUMPTIONS, normalizePlan } from "../src/model.js";
import { syntheticPlan } from "./helpers/synthetic.js";

const constantSchedule = (p = syntheticPlan()): YearRates[] => {
  const a = p.assumptions;
  const out: YearRates[] = [];
  for (let y = a.start_year; y <= a.end_year; y++)
    out.push({ year: y, ret: a.ret, inflation: a.inflation });
  return out;
};

describe("per-year rate schedule", () => {
  it("constant schedule reproduces the no-schedule run (<$0.01/cell)", () => {
    const plan = syntheticPlan();
    const base = run(plan);
    const scheduled = run(plan, undefined, constantSchedule(plan));
    expect(scheduled.length).toBe(base.length);
    for (let i = 0; i < base.length; i++)
      for (const k of ["net_worth", "liquid_net_worth", "income", "expenses",
                       "taxes", "withdrawals", "contributions"] as const)
        expect(Math.abs(scheduled[i]![k] - base[i]![k]), `${base[i]!.year} ${k}`).toBeLessThan(0.01);
  });
  it("a bad-year schedule reduces net worth vs constant", () => {
    // Checked at retirement_year rather than the final simulated year:
    // this synthetic household (default assumptions run the horizon to
    // age 101) fully depletes liquid assets well before end_year in the
    // *unshocked* baseline too, so by the last row both runs have long
    // since converged on the same house-equity floor and a single early
    // bad year is invisible there. retirement_year is comfortably inside
    // the still-solvent accumulation phase for both runs.
    const plan = syntheticPlan();
    const sched = constantSchedule(plan);
    sched[1] = { ...sched[1]!, ret: -0.30 };
    const scheduledRow = run(plan, undefined, sched).find((r) => r.year === plan.assumptions.retirement_year)!;
    const baseRow = run(plan).find((r) => r.year === plan.assumptions.retirement_year)!;
    expect(scheduledRow.net_worth).toBeLessThan(baseRow.net_worth);
  });
  it("incomplete schedule throws", () => {
    expect(() => run(syntheticPlan(), undefined, [{ year: 2026, ret: 0.07, inflation: 0.03 }]))
      .toThrowError(/rates schedule/);
  });
  it("schedule inflation drives income indexing", () => {
    const plan = syntheticPlan();
    const sched = constantSchedule(plan).map(r => ({ ...r, inflation: 0 }));
    const rows = run(plan, undefined, sched);
    // with zero inflation, a today's-$ income is flat (frac-adjusted year 1)
    expect(rows[2]!.income).toBeCloseTo(rows[1]!.income, 6);
  });
  it("nominal_at_start expense pre-dating start_year compounds from its own start, not start_year", () => {
    // Regression: the running-multiplier expGrow used to seed at 1.0 for
    // every expense, so a nominal_at_start expense whose start predates
    // start_year only compounded once (start_year - 1 years of growth
    // were dropped) instead of (start_year - start) years, under-inflating
    // by ~5.7% for a 2023 start against a 2026 horizon.
    const plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "cash", tax: "cash", balance: 1_000_000, growth: 0 }],
      incomes: [],
      social_security: [],
      expenses: [{ name: "car", amount: 1000, start: 2023, end: 2091, nominal_at_start: true }],
      contributions: [],
      assumptions: { ...DEFAULT_ASSUMPTIONS, retirement_year: 2099 },
    });
    const rows = run(plan);
    // 1000 * 1.03^(2026-2023) = 1092.727
    expect(rows.find((r) => r.year === 2026)!.expenses).toBeCloseTo(1092.727, 3);
    // 1000 * 1.03^(2030-2023) = 1229.874
    expect(rows.find((r) => r.year === 2030)!.expenses).toBeCloseTo(1229.874, 3);
  });
  it("an account with explicit growth ignores the schedule's ret", () => {
    const plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "cash", tax: "cash", balance: 1000, growth: 0 }],
      incomes: [],
      social_security: [],
      expenses: [],
      contributions: [],
      assumptions: { ...DEFAULT_ASSUMPTIONS },
    });
    const a = plan.assumptions;
    const sched: YearRates[] = [];
    for (let y = a.start_year; y <= a.end_year; y++) sched.push({ year: y, ret: -0.5, inflation: a.inflation });
    const rows = run(plan, undefined, sched);
    for (const r of rows) expect(r.net_worth).toBe(1000);
  });
  it("non-finite schedule values throw", () => {
    const plan = syntheticPlan();
    const sched = constantSchedule(plan);
    sched[0] = { ...sched[0]!, ret: NaN };
    expect(() => run(plan, undefined, sched)).toThrowError(/non-finite/);
  });
});
