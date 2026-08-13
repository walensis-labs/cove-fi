/**
 * 0.5.0 Task 3: Contribution.hard_end (engine guard) + the pretax-stop
 * cash-flow semantics that fall out of it for free.
 *
 * hard_end: a rung is inactive whenever `c.hard_end != null && y > c.hard_end`
 * — evaluated alongside the existing COAST/window checks in the
 * convergence loop's contribution pass. It caps a rung independent of
 * `end` (including a COAST-end rung's own `end`); whichever ends first
 * governs. This file is created here and extended in Task 4.
 */
import { describe, expect, it } from "vitest";
import { run, runWithMeta } from "../src/engine.js";
import { COAST, DEFAULT_ASSUMPTIONS, normalizePlan, type Plan } from "../src/model.js";

describe("Contribution.hard_end — engine guard", () => {
  // Reuses the exact plan shape from coast.test.ts's "COAST-rung
  // interaction" block (deterministic recurrence bal_y = (bal_{y-1} +
  // 200000) * 1.07, target 25 x 40000 = 1,000,000, inflation 0) — that file
  // independently establishes the BASELINE (no hard_end) outcome: this
  // plan coasts at 2029, and the COAST-end rung funds fully through 2029
  // then drops to 0 the following year (2030). hard_end is layered on top
  // here to pin which sentinel governs when the two disagree.
  function buildPlan(hardEnd?: number): Plan {
    return normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "B", tax: "taxable", balance: 10_000, basis: 10_000 }],
      incomes: [{ name: "salary", amount: 500_000, start: 2026, end: 2030 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [
        {
          account: "B",
          start: 2026,
          end: COAST,
          amount: 200_000,
          ...(hardEnd != null ? { hard_end: hardEnd } : {}),
        },
      ],
      house: null,
      assumptions: {
        ...DEFAULT_ASSUMPTIONS,
        start_year: 2026,
        end_year: 2032,
        retirement_year: 2031,
        inflation: 0,
        fi_multiple: 25,
        ret: 0.07,
      },
    });
  }

  it("baseline (no hard_end): coasts at 2029, COAST-end rung funds through 2029 then stops at 2030", () => {
    const { rows, coast_year } = runWithMeta(buildPlan());
    expect(coast_year).toBe(2029);
    const contribByYear = new Map(rows.map((r) => [r.year, r.contributions]));
    expect(contribByYear.get(2029)).toBeCloseTo(200_000, 2);
    expect(contribByYear.get(2030)).toBe(0);
  });

  it("hard_end BEFORE the coast trigger fires (2027 < 2029): the rung stops at hard_end, not at coast — and, starved of contributions, this plan never coasts within the horizon at all", () => {
    const { rows, coast_year } = runWithMeta(buildPlan(2027));
    const contribByYear = new Map(rows.map((r) => [r.year, r.contributions]));
    expect(contribByYear.get(2026)).toBeCloseTo(200_000, 2);
    expect(contribByYear.get(2027)).toBeCloseTo(200_000, 2);
    // y > hard_end: inactive, regardless of the COAST-end sentinel never
    // having triggered (inCoast is still false every one of these years).
    expect(contribByYear.get(2028)).toBe(0);
    expect(contribByYear.get(2029)).toBe(0);
    expect(contribByYear.get(2030)).toBe(0);
    expect(coast_year).toBeNull();
  });

  it("hard_end AFTER the coast trigger fires (2035 > 2029): COAST governs first, hard_end never binds — byte-identical to the no-hard_end baseline", () => {
    const baseline = runWithMeta(buildPlan());
    const withLateHardEnd = runWithMeta(buildPlan(2035));
    expect(withLateHardEnd.coast_year).toBe(baseline.coast_year);
    expect(withLateHardEnd.rows).toEqual(baseline.rows);
  });
});

describe("pretax-stop: stopping a pretax rung natively returns amount x (1 - rate) to cash flow", () => {
  // Probe: income 100k, a single pretax rung (amount 10k, hard_end 2027,
  // no annual_limit_key/to_limit so `want` is a flat $10,000/yr), horizon
  // 2026-2029, ret 0 (the rung's target account never grows, irrelevant to
  // this pin), dividend_rate 0 (belt-and-suspenders — the target account
  // isn't `taxable` anyway, so it wouldn't accrue dividends regardless).
  // ordRate = income_tax(0.30) + local_tax(0.01) = 0.31 (DEFAULT_ASSUMPTIONS,
  // left un-overridden). No engine change is required for this pin — it
  // falls straight out of the existing iterative tax/cash-flow waterfall
  // once hard_end deactivates the rung.
  //
  // Derivation (no other expenses in the plan, so 100% of leftover cash
  // flow lands in `expenses` via cashFlowDefault: "spend"):
  //   y <= 2027 (rung active):
  //     taxes  = (100,000 - 10,000) x 0.31 = 27,900
  //     contributions = 10,000
  //     expenses (surplus) = 100,000 - 27,900 - 10,000 = 62,100
  //   y > 2027 (rung inactive, hard_end):
  //     taxes  = 100,000 x 0.31 = 31,000
  //     contributions = 0
  //     expenses (surplus) = 100,000 - 31,000 - 0 = 69,000
  //   delta taxes    = 31,000 - 27,900 = +3,100 = 10,000 x 0.31        ✓
  //   delta expenses = 69,000 - 62,100 = +6,900 = 10,000 x (1 - 0.31)  ✓
  //   (the stopped pretax contribution's $10,000 splits exactly between
  //   the two: the tax the household now owes on it, and the rest spent.)
  function buildPlan(): Plan {
    return normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "pretax_401k", tax: "trad", balance: 0, growth: 0 }],
      incomes: [{ name: "salary", amount: 100_000, start: 2026, end: 2091 }],
      social_security: [],
      expenses: [],
      contributions: [{ account: "pretax_401k", start: 2026, end: 2091, amount: 10_000, pretax: true, hard_end: 2027 }],
      house: null,
      assumptions: {
        ...DEFAULT_ASSUMPTIONS,
        start_year: 2026,
        end_year: 2029,
        retirement_year: 2091,
        ret: 0,
        dividend_rate: 0,
        // flat-dollar across years — the brief's numbers hold identically
        // in both years on each side of the hard_end boundary, which only
        // works with no inflation growth on income/contribution amounts.
        inflation: 0,
      },
    });
  }

  it("matches the hand-derived taxes/contributions/expenses exactly on both sides of the hard_end boundary", () => {
    const rows = run(buildPlan());
    const byYear = new Map(rows.map((r) => [r.year, r]));

    for (const y of [2026, 2027]) {
      const r = byYear.get(y)!;
      expect(r.taxes).toBeCloseTo(27_900, 6);
      expect(r.contributions).toBeCloseTo(10_000, 6);
      expect(r.expenses).toBeCloseTo(62_100, 6);
    }
    for (const y of [2028, 2029]) {
      const r = byYear.get(y)!;
      expect(r.taxes).toBeCloseTo(31_000, 6);
      expect(r.contributions).toBe(0);
      expect(r.expenses).toBeCloseTo(69_000, 6);
    }

    const deltaTaxes = byYear.get(2028)!.taxes - byYear.get(2027)!.taxes;
    const deltaExpenses = byYear.get(2028)!.expenses - byYear.get(2027)!.expenses;
    expect(deltaTaxes).toBeCloseTo(10_000 * 0.31, 6);
    expect(deltaExpenses).toBeCloseTo(10_000 * (1 - 0.31), 6);
  });
});
