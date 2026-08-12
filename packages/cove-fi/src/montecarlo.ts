/**
 * Monte Carlo — seedable PRNG, block bootstrap over the vendored historical
 * S&P 500 / inflation series, percentile bands over per-trial net worth.
 */
import { RETURNS_ANNUAL } from "./data/returnsAnnual.js";
import { run, type YearRates } from "./engine.js";
import { type Assumptions, normalizePlan, type Plan } from "./model.js";

export interface MonteCarloOptions {
  trials?: number;
  seed?: number;
  overrides?: Partial<Assumptions>;
}

export interface MonteCarloResult {
  success_rate: number; // fraction of trials with liquid NW > 0 every year
  trials: number;
  seed: number; // the seed actually used
  years: number[];
  percentiles: { p10: number[]; p25: number[]; p50: number[]; p75: number[]; p90: number[] }; // net_worth per year
}

/** mulberry32 — standard deterministic PRNG, returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Block bootstrap: repeatedly pick a uniform random start index into
 * RETURNS_ANNUAL and take 5 consecutive entries (wrapping to index 0 when a
 * block would run past the end of history — this reuses early history to
 * pad the tail of long blocks rather than ever reading out of bounds),
 * until the schedule covers every requested year, then truncate. Each
 * sampled historical entry supplies { ret: sp500, inflation } for the next
 * requested year in order.
 */
export function sampleSchedule(years: number[], rng: () => number): YearRates[] {
  const n = RETURNS_ANNUAL.length;
  const out: YearRates[] = [];
  while (out.length < years.length) {
    const start = Math.floor(rng() * n);
    for (let i = 0; i < 5 && out.length < years.length; i++) {
      const src = RETURNS_ANNUAL[(start + i) % n]!;
      out.push({ year: years[out.length]!, ret: src.sp500, inflation: src.inflation });
    }
  }
  return out;
}

function percentileOf(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0]!;
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

export function runMonteCarlo(plan: Plan, opts: MonteCarloOptions = {}): MonteCarloResult {
  const trials = opts.trials ?? 1000;
  const seed = opts.seed ?? crypto.getRandomValues(new Uint32Array(1))[0]!;
  const overrides = opts.overrides;

  // Resolve the effective start/end year exactly as run() would (defaults
  // merged, then overrides applied) so the bootstrapped schedule's year
  // range matches what every trial's run() call requires — built once and
  // reused across all trials since overrides are constant per Monte Carlo
  // call.
  const baseAssumptions = normalizePlan(plan).assumptions;
  const a: Assumptions = overrides ? { ...baseAssumptions, ...overrides } : baseAssumptions;
  const years: number[] = [];
  for (let y = a.start_year; y <= a.end_year; y++) years.push(y);

  const rng = mulberry32(seed);
  const netWorthByYear: number[][] = years.map(() => []);
  let successes = 0;

  for (let t = 0; t < trials; t++) {
    const rates = sampleSchedule(years, rng);
    const rows = run(plan, overrides, rates);
    let allPositive = true;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      netWorthByYear[i]!.push(row.net_worth);
      if (!(row.liquid_net_worth > 0)) allPositive = false;
    }
    if (allPositive) successes++;
  }

  const percentiles = { p10: [] as number[], p25: [] as number[], p50: [] as number[], p75: [] as number[], p90: [] as number[] };
  for (const vals of netWorthByYear) {
    const sorted = [...vals].sort((x, y) => x - y);
    percentiles.p10.push(percentileOf(sorted, 0.1));
    percentiles.p25.push(percentileOf(sorted, 0.25));
    percentiles.p50.push(percentileOf(sorted, 0.5));
    percentiles.p75.push(percentileOf(sorted, 0.75));
    percentiles.p90.push(percentileOf(sorted, 0.9));
  }

  return { success_rate: successes / trials, trials, seed, years, percentiles };
}
