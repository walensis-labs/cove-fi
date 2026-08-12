import { describe, expect, it } from "vitest";
import { mulberry32, runMonteCarlo, sampleSchedule } from "../src/montecarlo.js";
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
});
