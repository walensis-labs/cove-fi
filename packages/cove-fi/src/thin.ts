/**
 * Row/percentile-series thinning for the MCP server's context-window
 * budget (MCP-only — the CLI's `mc --json`/`run --json`/`compare --json`
 * output is always full-resolution, untruncated). Kept out of
 * `mcp/server.ts` as its own module so the thinning/rounding logic doesn't
 * statically pull the MCP SDK into anything that imports it.
 *
 * Sampling rule: first 5 years, every 5th year thereafter, retirement year
 * +/-2, and the final year. Hard bound: never returns more than MAX_ROWS
 * indices, regardless of series length — if the sampled set is still too
 * big, it's evenly downsampled (see `downsampleIndices`).
 */
import type { YearRow } from "./engine.js";
import type { MonteCarloResult } from "./montecarlo.js";

const MAX_ROWS = 30;

/** Evenly spaced downsample of a sorted, deduped index list to at most
 * `max` entries. Always keeps the first and last index. */
export function downsampleIndices(indices: number[], max: number): number[] {
  if (indices.length <= max) return indices;
  const lastIdx = indices.length - 1;
  const step = lastIdx / (max - 1);
  const out = new Set<number>();
  for (let k = 0; k < max; k++) {
    out.add(indices[Math.round(k * step)]!);
  }
  return [...out].sort((a, b) => a - b);
}

/** The index set thinning keeps, before the hard-bound downsample. Exposed
 * separately from `thinRows` so `compare_scenarios` (and `monte_carlo`) can
 * apply one shared index set across a `years` array and every aligned
 * series (percentile bands, per-scenario rows, ...) — they're index-aligned
 * by construction, so one derived index set stays consistent across all of
 * them without re-deriving it per series. */
export function thinIndices(years: number[], retirementYear: number): number[] {
  const n = years.length;
  if (n === 0) return [];
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(5, n); i++) keep.add(i);
  for (let i = 5; i < n; i += 5) keep.add(i);
  for (let i = 0; i < n; i++) {
    if (Math.abs(years[i]! - retirementYear) <= 2) keep.add(i);
  }
  keep.add(n - 1);
  return downsampleIndices([...keep].sort((a, b) => a - b), MAX_ROWS);
}

export function thinRows(rows: YearRow[], retirementYear: number): YearRow[] {
  return thinIndices(
    rows.map((r) => r.year),
    retirementYear,
  ).map((i) => rows[i]!);
}

/** Thins + rounds a MonteCarloResult for a small context window / terminal:
 * `years` and every percentile series share one index set (derived from
 * `years` itself), dollar values round to whole dollars, and success_rate
 * rounds to 4 decimal places. Nominal-dollar only — MonteCarloResult never
 * carries a today's-$ series (see montecarlo.ts). */
export function thinMonteCarloResult(mc: MonteCarloResult, retirementYear: number): MonteCarloResult {
  const indices = thinIndices(mc.years, retirementYear);
  const years = indices.map((i) => mc.years[i]!);
  const round = (arr: number[]) => indices.map((i) => Math.round(arr[i]!));
  return {
    success_rate: Math.round(mc.success_rate * 10_000) / 10_000,
    trials: mc.trials,
    seed: mc.seed,
    years,
    percentiles: {
      p10: round(mc.percentiles.p10),
      p25: round(mc.percentiles.p25),
      p50: round(mc.percentiles.p50),
      p75: round(mc.percentiles.p75),
      p90: round(mc.percentiles.p90),
    },
  };
}
