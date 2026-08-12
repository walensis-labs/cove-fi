import { describe, expect, it } from "vitest";
import { mulberry32, runMonteCarlo, sampleSchedule } from "../src/montecarlo.js";
import { planFromJson } from "../src/planjson.js";
import { syntheticPlan } from "./helpers/synthetic.js";

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
