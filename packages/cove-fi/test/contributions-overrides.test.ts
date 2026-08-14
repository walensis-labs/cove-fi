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
import { COAST, DEFAULT_ASSUMPTIONS, IRS_LIMITS_2026, normalizePlan, type Contribution, type Plan } from "../src/model.js";
import { applyOverrides, Session } from "../src/session.js";

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

/**
 * 0.5.0 Task 4: applyOverrides — contributions {end, keep, scale}.
 *
 * Income is set high ($1,000,000/yr) so `available` cash flow never binds
 * `amt = min(want, available)` — every rung contributes exactly `want`,
 * making the contributions column a direct readout of each rung's
 * post-override amount. Single-rung plans isolate one rung's behavior in
 * the `contributions` column; ret/inflation are 0 so amounts don't drift
 * across years.
 */
describe("applyOverrides — contributions {end, keep, scale}", () => {
  function buildPlan(contributions: Contribution[], endYear = 2032): Plan {
    return normalizePlan({
      birth_year: 1990,
      accounts: [
        { name: "A", tax: "taxable", balance: 0, growth: 0 },
        { name: "B", tax: "taxable", balance: 0, growth: 0 },
      ],
      incomes: [{ name: "salary", amount: 1_000_000, start: 2026, end: 2091 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions,
      house: null,
      assumptions: {
        ...DEFAULT_ASSUMPTIONS,
        start_year: 2026,
        end_year: endYear,
        retirement_year: 2091,
        inflation: 0,
        ret: 0,
      },
    });
  }

  it("keep-exempts-both: a kept rung contributes past the clamp at full amount", () => {
    const plan = buildPlan([{ account: "A", start: 2026, end: 2091, amount: 10_000, name: "keepme" }]);
    const out = applyOverrides(plan, { contributions: { keep: ["keepme"], scale: 0.5, end: 2027 } });
    // Kept rung is byte-untouched — same object shape as the input's rung.
    expect(out.contributions[0]).toEqual(plan.contributions[0]);
    const { rows } = runWithMeta(out);
    const contribByYear = new Map(rows.map((r) => [r.year, r.contributions]));
    for (let y = 2026; y <= 2032; y++) {
      expect(contribByYear.get(y)).toBeCloseTo(10_000, 6); // never scaled, never clamped
    }
  });

  it("scale-then-clamp order pinned: scale 0.5 + end — half-amounts until end, zero after", () => {
    const plan = buildPlan([{ account: "A", start: 2026, end: 2091, amount: 10_000 }]);
    const out = applyOverrides(plan, { contributions: { scale: 0.5, end: 2027 } });
    const { rows } = runWithMeta(out);
    const contribByYear = new Map(rows.map((r) => [r.year, r.contributions]));
    expect(contribByYear.get(2026)).toBeCloseTo(5_000, 6);
    expect(contribByYear.get(2027)).toBeCloseTo(5_000, 6);
    expect(contribByYear.get(2028)).toBe(0);
    expect(contribByYear.get(2030)).toBe(0);
  });

  it("end never extends: a rung with its own end 2030 still stops at 2030 despite override end 2035", () => {
    const plan = buildPlan([{ account: "A", start: 2026, end: 2030, amount: 10_000 }]);
    const out = applyOverrides(plan, { contributions: { end: 2035 } });
    expect(out.contributions[0]!.hard_end).toBe(2035); // tightened per the formula...
    const { rows } = runWithMeta(out);
    const contribByYear = new Map(rows.map((r) => [r.year, r.contributions]));
    for (let y = 2026; y <= 2030; y++) expect(contribByYear.get(y)).toBeCloseTo(10_000, 6);
    // ...but the rung's own `end` still governs — hard_end can only tighten, never extend.
    for (let y = 2031; y <= 2032; y++) expect(contribByYear.get(y)).toBe(0);
  });

  it("unknown keep name throws, naming it (unnamed rungs can never be kept)", () => {
    const named = buildPlan([{ account: "A", start: 2026, end: 2091, amount: 10_000, name: "alpha" }]);
    expect(() => applyOverrides(named, { contributions: { keep: ["bravo"] } })).toThrowError(/bravo/);

    const unnamed = buildPlan([{ account: "A", start: 2026, end: 2091, amount: 10_000 }]);
    expect(() => applyOverrides(unnamed, { contributions: { keep: ["anything"] } })).toThrowError(/anything/);
  });

  it("scale 0 + no end = never-contributed counterfactual (contributions column all zero)", () => {
    const plan = buildPlan([{ account: "A", start: 2026, end: 2091, amount: 10_000 }]);
    const out = applyOverrides(plan, { contributions: { scale: 0 } });
    const { rows } = runWithMeta(out);
    for (const r of rows) expect(r.contributions).toBe(0);
  });

  it("scale also converts a to_limit rung to a fixed amount = IRS limit x scale, dropping to_limit", () => {
    const plan = buildPlan([
      { account: "A", start: 2026, end: 2091, to_limit: true, annual_limit_key: "401k" },
    ]);
    const out = applyOverrides(plan, { contributions: { scale: 0.5 } });
    expect(out.contributions[0]!.to_limit).toBe(false);
    expect(out.contributions[0]!.amount).toBeCloseTo(IRS_LIMITS_2026["401k"] * 0.5);
  });

  it("validates scale (finite >= 0), end (finite integer), and keep (array of strings)", () => {
    const plan = buildPlan([{ account: "A", start: 2026, end: 2091, amount: 10_000, name: "alpha" }]);
    expect(() => applyOverrides(plan, { contributions: { scale: -1 } })).toThrow();
    expect(() => applyOverrides(plan, { contributions: { scale: Number.NaN } })).toThrow();
    expect(() => applyOverrides(plan, { contributions: { scale: Number.POSITIVE_INFINITY } })).toThrow();
    expect(() => applyOverrides(plan, { contributions: { end: 2027.5 } })).toThrow();
    expect(() => applyOverrides(plan, { contributions: { end: Number.NaN } })).toThrow();
    expect(() => applyOverrides(plan, { contributions: { keep: [42] as unknown as string[] } })).toThrow();
  });

  it("purity: never mutates a deep-frozen input plan", () => {
    function deepFreeze<T>(v: T): T {
      if (v !== null && (typeof v === "object" || Array.isArray(v))) {
        for (const k of Object.keys(v as object)) {
          deepFreeze((v as Record<string, unknown>)[k]);
        }
        Object.freeze(v);
      }
      return v;
    }
    const frozen = deepFreeze(
      buildPlan([
        { account: "A", start: 2026, end: 2091, amount: 10_000, name: "keepme" },
        { account: "B", start: 2026, end: 2091, amount: 20_000 },
      ]),
    );
    expect(() =>
      applyOverrides(frozen, { contributions: { keep: ["keepme"], scale: 0.5, end: 2027 } }),
    ).not.toThrow();
  });

  it("atomicity: an invalid contributions override leaves the session plan intact and throws", () => {
    const plan = buildPlan([{ account: "A", start: 2026, end: 2091, amount: 10_000, name: "alpha" }]);
    const session = new Session();
    session.plan = plan;
    session.defineScenario("bad", { contributions: { scale: -1 } });
    expect(() => session.runProjection("bad")).toThrow();
    expect(session.plan).toEqual(plan);
  });

  it("atomicity: a bad keep name thrown AFTER savings_rate_multiplier already mutated the draft still leaves the session plan intact", () => {
    // savings_rate_multiplier runs first in applyOverrides and rewrites
    // copy.contributions[0].amount before the contributions block even
    // resolves `keep` — this pins that the throw still unwinds cleanly
    // (copy is a local structuredClone; the session's plan was never
    // touched regardless of how much of `copy` got mutated first).
    const plan = buildPlan([{ account: "A", start: 2026, end: 2091, amount: 10_000, name: "alpha" }]);
    const session = new Session();
    session.plan = plan;
    session.defineScenario("bad", { savings_rate_multiplier: 0.5, contributions: { keep: ["nonexistent"] } });
    expect(() => session.runProjection("bad")).toThrowError(/nonexistent/);
    expect(session.plan).toEqual(plan);
    // session isn't left wedged — a valid scenario still runs afterward.
    session.defineScenario("good", { savings_rate_multiplier: 0.5 });
    expect(() => session.runProjection("good")).not.toThrow();
  });

  it("composes with savings_rate_multiplier: multiplier 0.5 then scale 0.5 => non-kept amounts x0.25, pinned via engine output", () => {
    const plan = buildPlan([{ account: "A", start: 2026, end: 2091, amount: 10_000 }]);
    const out = applyOverrides(plan, { savings_rate_multiplier: 0.5, contributions: { scale: 0.5 } });
    const { rows } = runWithMeta(out);
    const contribByYear = new Map(rows.map((r) => [r.year, r.contributions]));
    for (let y = 2026; y <= 2032; y++) {
      expect(contribByYear.get(y)).toBeCloseTo(10_000 * 0.25, 6);
    }
  });

  it("keep scopes to the contributions override only — savings_rate_multiplier still applies to kept rungs (pinned via engine output)", () => {
    // Controller ruling on the spec-silent fork: `keep` exempts a rung from
    // `contributions.scale`/`.end` only. savings_rate_multiplier is a
    // blanket knob that predates `keep` and models overall savings
    // behavior — it still touches every rung, kept or not.
    const overrides = { savings_rate_multiplier: 0.5, contributions: { scale: 0.5, keep: ["x"] } };

    // Isolate the kept rung first: a plan containing ONLY "x" (kept) — its
    // engine-output contribution should reflect the multiplier alone.
    const keptOnly = buildPlan([{ account: "A", start: 2026, end: 2091, amount: 10_000, name: "x" }]);
    const keptYear1 = runWithMeta(applyOverrides(keptOnly, overrides)).rows.find((r) => r.year === 2026)!
      .contributions;
    expect(keptYear1).toBeCloseTo(10_000 * 0.5, 6); // multiplier only — kept exempts contributions.scale

    // Now add a second, non-kept named rung "y" to the SAME plan and apply
    // the SAME override call — the summed contributions column must equal
    // "x"'s already-pinned 5,000 plus "y"'s multiplier-then-scale 2,500,
    // proving `keep` scoped its exemption to "x" alone within one call.
    const both = buildPlan([
      { account: "A", start: 2026, end: 2091, amount: 10_000, name: "x" },
      { account: "B", start: 2026, end: 2091, amount: 10_000, name: "y" },
    ]);
    const combinedYear1 = runWithMeta(applyOverrides(both, overrides)).rows.find((r) => r.year === 2026)!
      .contributions;
    expect(combinedYear1).toBeCloseTo(keptYear1 + 10_000 * 0.25, 6); // x (multiplier only) + y (multiplier, then scale)
  });

  it("triple chain: to_limit + savings_rate_multiplier 0.5 + contributions.scale 0.5 => engine contributes limit x 0.25 x first_year_fraction in year 1", () => {
    // savings_rate_multiplier converts the to_limit rung to a fixed
    // amount = IRS_LIMITS_2026["401k"] * 0.5 and drops to_limit (see the
    // savings_rate_multiplier tests above); contributions.scale then sees
    // an ordinary (non-to_limit) rung and multiplies that amount by 0.5
    // again => amount = limit * 0.25, in 2026 dollars. The engine's `want`
    // for an amount rung is `c.amount * f * frac`; at y === start_year, f
    // is always 1.0 (engine.ts only accumulates it for y > start_year) and
    // frac === first_year_fraction (0.5 here, to actually exercise the
    // factor rather than have it default away to 1.0). So year-1
    // want = limit * 0.25 * 1.0 * 0.5 = limit * 0.125, and $1,000,000 of
    // income leaves ample `available` cash flow so amt === want exactly.
    const firstYearFraction = 0.5;
    const plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "A", tax: "taxable", balance: 0, growth: 0 }],
      incomes: [{ name: "salary", amount: 1_000_000, start: 2026, end: 2091 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [{ account: "A", start: 2026, end: 2091, to_limit: true, annual_limit_key: "401k" }],
      house: null,
      assumptions: {
        ...DEFAULT_ASSUMPTIONS,
        start_year: 2026,
        end_year: 2028,
        retirement_year: 2091,
        inflation: 0,
        ret: 0,
        first_year_fraction: firstYearFraction,
      },
    });
    const out = applyOverrides(plan, { savings_rate_multiplier: 0.5, contributions: { scale: 0.5 } });
    const year1 = runWithMeta(out).rows.find((r) => r.year === 2026)!;
    const expected = IRS_LIMITS_2026["401k"] * 0.25 * firstYearFraction;
    expect(year1.contributions).toBeCloseTo(expected, 4);
  });
});
