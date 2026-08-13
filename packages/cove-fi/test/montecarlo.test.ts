import { describe, expect, it } from "vitest";
import { mulberry32, runMonteCarlo, sampleSchedule } from "../src/montecarlo.js";
import { planFromJson } from "../src/planjson.js";
import { syntheticPlan } from "./helpers/synthetic.js";

// Invested-only probe: NO cash-class accounts at all, so the upcoming
// cash_ret wiring (Task 5 — cash sleeves follow a correlated T-bill path)
// has literally nothing to touch here. Every account is taxable/trad/roth,
// so growth is driven entirely by the sampled sp500 path.
function investedOnlyProbe() {
  return planFromJson({
    birth_year: 1990,
    accounts: [
      { name: "brokerage", tax: "taxable", balance: 50_000, basis: 20_000 },
      { name: "401k", tax: "trad", balance: 100_000 },
      { name: "roth", tax: "roth", balance: 20_000 },
    ],
    incomes: [{ name: "salary", amount: 90_000, start: 2026, end: 2051 }],
    social_security: [],
    contributions: [
      { account: "401k", start: 2026, end: 2051, amount: 10_000, pretax: true },
      { account: "roth", start: 2026, end: 2051, amount: 5_000 },
    ],
    expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2060 }],
    house: null,
    assumptions: {
      start_year: 2026, end_year: 2060, first_year_fraction: 1.0, retirement_year: 2052,
      dividend_rate: 0.015, inflation: 0.03, ret: 0.07, income_tax: 0.3, local_tax: 0.01,
      cap_gains_tax: 0.15, coast_multiple: 4.0, fi_multiple: 25.0,
    },
  });
}

describe("monte carlo", () => {
  it("mulberry32 is deterministic and uniform-ish", () => {
    const a = mulberry32(42), b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45); expect(mean).toBeLessThan(0.55);
  });
  it("sampleSchedule covers requested years with 5-year blocks", () => {
    const years = Array.from({ length: 40 }, (_, i) => 2026 + i);
    const sched = sampleSchedule(years, mulberry32(1));
    expect(sched.map(s => s.year)).toEqual(years);
    for (const s of sched) expect(Number.isFinite(s.ret) && Number.isFinite(s.inflation)).toBe(true);
  });
  it("sampleSchedule's cash_ret is finite and comes from the SAME sampled index as ret/inflation", () => {
    const years = Array.from({ length: 40 }, (_, i) => 2026 + i);
    const sched = sampleSchedule(years, mulberry32(1));
    for (const s of sched) expect(Number.isFinite(s.cash_ret)).toBe(true);
    // cash_ret must not equal the equity path (it's tbill, not sp500) —
    // guards against an accidental ret/cash_ret aliasing bug.
    expect(sched.some((s) => s.cash_ret !== s.ret)).toBe(true);
  });
  it("fixed seed => identical results", () => {
    const r1 = runMonteCarlo(syntheticPlan(), { trials: 50, seed: 7 });
    const r2 = runMonteCarlo(syntheticPlan(), { trials: 50, seed: 7 });
    expect(r1).toEqual(r2);
  });
  it("percentile bands are ordered and shaped", () => {
    const r = runMonteCarlo(syntheticPlan(), { trials: 100, seed: 3 });
    expect(r.success_rate).toBeGreaterThanOrEqual(0);
    expect(r.success_rate).toBeLessThanOrEqual(1);
    expect(r.years.length).toBe(r.percentiles.p50.length);
    for (let i = 0; i < r.years.length; i++) {
      expect(r.percentiles.p10[i]!).toBeLessThanOrEqual(r.percentiles.p25[i]!);
      expect(r.percentiles.p25[i]!).toBeLessThanOrEqual(r.percentiles.p50[i]!);
      expect(r.percentiles.p50[i]!).toBeLessThanOrEqual(r.percentiles.p75[i]!);
      expect(r.percentiles.p75[i]!).toBeLessThanOrEqual(r.percentiles.p90[i]!);
    }
  });
  it("1000 trials completes under 5s", () => {
    const t0 = performance.now();
    runMonteCarlo(syntheticPlan(), { trials: 1000, seed: 1 });
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
  it("trials: 0 throws with positive integer error", () => {
    expect(() => runMonteCarlo(syntheticPlan(), { trials: 0 })).toThrow(/positive integer/);
  });
  it("trials: 10.5 throws with positive integer error", () => {
    expect(() => runMonteCarlo(syntheticPlan(), { trials: 10.5 })).toThrow(/positive integer/);
  });
});

describe("pure-equity MC pin (Task 5 — cash path, captured BEFORE cash_ret wiring)", () => {
  // sp500 path must not move when cash_ret wiring lands: this plan has no
  // cash-class accounts, so every account's growth comes from resolveRet()
  // -> the sampled sp500 path, untouched by the cash_ret schedule field
  // Task 5 adds. Values below were captured by running this exact
  // runMonteCarlo call against pre-Task-5 code (seed 11, 200 trials) —
  // committed separately, BEFORE any cash_ret wiring, as the regression pin.
  it("invested-only plan MC output is pinned (must survive cash_ret wiring unchanged)", () => {
    const r = runMonteCarlo(investedOnlyProbe(), { trials: 200, seed: 11 });
    expect(r.success_rate).toBeCloseTo(0.99, 10);
    expect(r.percentiles.p10[r.years.length - 1]).toBeCloseTo(1_314_104.1595670753, 4);
    expect(r.percentiles.p50[r.years.length - 1]).toBeCloseTo(9_971_233.59005253, 4);
    expect(r.percentiles.p90[r.years.length - 1]).toBeCloseTo(29_564_293.282805584, 4);
  });
});

describe("Monte Carlo cash path (Task 5 — cash sleeves follow a correlated T-bill path)", () => {
  // Same shape as the Trinity-study retiree() below, zero taxes so the
  // comparison isolates growth-rate variance only: one plan holds its
  // entire $1M in a GATED cash account (acc.ret set, so cashTaxGated is
  // true — but with ordinary tax rate 0 the gating is a no-op on the
  // dollar totals, isolating pure growth-path variance), the other holds
  // the identical balance in a taxable equity account. Both draw the same
  // $40k/yr real spend over the same 30-year horizon.
  const buildPlan = (tax: "cash" | "taxable") => planFromJson({
    birth_year: 1961,
    accounts: [
      tax === "cash"
        ? { name: "cash", tax: "cash", balance: 1_000_000, ret: 0.0 } // ret set (even at 0) gates ordinary-income cash tax
        : { name: "stocks", tax: "taxable", balance: 1_000_000, basis: 1_000_000 },
    ],
    incomes: [], social_security: [], contributions: [], house: null,
    expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2055 }],
    assumptions: { start_year: 2026, end_year: 2055, first_year_fraction: 1.0,
      retirement_year: 2026, dividend_rate: 0, inflation: 0.03, ret: 0.07,
      income_tax: 0, local_tax: 0, cap_gains_tax: 0,
      coast_multiple: 4.0, fi_multiple: 25.0 },
  });

  it("all-cash gated plan: p10 < p90 at every year (nonzero tbill variance)", () => {
    const r = runMonteCarlo(buildPlan("cash"), { trials: 500, seed: 5 });
    for (let i = 0; i < r.years.length; i++) {
      expect(r.percentiles.p10[i]!).toBeLessThan(r.percentiles.p90[i]!);
    }
  });

  it("all-cash gated plan's p10-p90 spread is strictly narrower than the same balance in taxable equity", () => {
    const cashResult = runMonteCarlo(buildPlan("cash"), { trials: 500, seed: 5 });
    const equityResult = runMonteCarlo(buildPlan("taxable"), { trials: 500, seed: 5 });
    for (let i = 0; i < cashResult.years.length; i++) {
      const cashSpread = cashResult.percentiles.p90[i]! - cashResult.percentiles.p10[i]!;
      const equitySpread = equityResult.percentiles.p90[i]! - equityResult.percentiles.p10[i]!;
      expect(cashSpread).toBeLessThan(equitySpread);
    }
  });

  it("fixed seed => byte-identical Monte Carlo results on a plan with a cash sleeve (determinism holds through cash_ret wiring)", () => {
    const r1 = runMonteCarlo(buildPlan("cash"), { trials: 60, seed: 13 });
    const r2 = runMonteCarlo(buildPlan("cash"), { trials: 60, seed: 13 });
    expect(r1).toEqual(r2);
  });
});

describe("withdrawal-rate benchmark (Trinity study / Bengen 1994)", () => {
  // Cooley, Hubbard & Walz (1998) "Retirement Savings: Choosing a Withdrawal
  // Rate That Is Sustainable" — 100% stocks, 30-year horizon, 4% initial
  // withdrawal, inflation-adjusted: ~98% historical success (1926-1995 data).
  // Bootstrap over 1928+ data (not overlapping historical windows) lands in a
  // similar band; we assert a tolerant window and treat falling OUT of it as
  // an engine/MC defect to investigate, never a bound to widen.
  const retiree = () => planFromJson({
    birth_year: 1961,
    accounts: [{ name: "stocks", tax: "roth", balance: 1_000_000 }],
    incomes: [], social_security: [], contributions: [], house: null,
    expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2055 }],
    assumptions: { start_year: 2026, end_year: 2055, first_year_fraction: 1.0,
      retirement_year: 2026, dividend_rate: 0, inflation: 0.03, ret: 0.07,
      income_tax: 0, local_tax: 0, cap_gains_tax: 0,   // literature ignores taxes; roth acct + zero rates make it tax-free
      coast_multiple: 4.0, fi_multiple: 25.0 },
  });
  it("4% rule, 100% stocks, 30 years lands in the published band", () => {
    const r = runMonteCarlo(retiree(), { trials: 2000, seed: 20260812 });
    expect(r.success_rate).toBeGreaterThanOrEqual(0.85);
    expect(r.success_rate).toBeLessThanOrEqual(1.0);
  });
  it("success rate falls as the withdrawal rate rises (Bengen direction)", () => {
    const at = (spend: number) => runMonteCarlo(
      { ...retiree(), expenses: [{ name: "living", amount: spend, start: 2026, end: 2055 }] },
      { trials: 1000, seed: 4 }).success_rate;
    expect(at(70_000)).toBeLessThan(at(40_000)); // 7% vs 4%
  });
});
