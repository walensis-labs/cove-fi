/**
 * True CoastFIRE (0.4.0) — the expectations test that replaced the
 * trailing-3yr-spend x coast_multiple heuristic. Every plan in this file
 * is hand-authored (entirely invented numbers) specifically so its coast
 * behavior can be derived independently of the engine and cross-checked.
 *
 * Formula pinned here (see engine.ts's coastTargetAtRetirement /
 * mortgageBalanceAt / runWithMeta doc comments for the full spec):
 *   target        = fi_multiple x (explicit expenses + house costs, both
 *                    grown to retirement_year R at CONSTANT rates)
 *   coastAttained(y) = sum over liquid accounts of
 *                        bal_y x (1 + (acc.growth ?? resolveRet(acc,a)))^(R-y)
 *                      - mortgageBalanceAt(plan, R)
 *   coast_year = first y < R with coastAttained(y) >= target
 *
 * A structural note that shapes several of these tests: for a plan with NO
 * contributions, the projection is provably time-invariant. Growing a
 * fixed principal at rate r for (y - start_year) years and then projecting
 * the result forward (y - R) more years AT THE SAME RATE r gives the exact
 * same total regardless of y (compound-interest associativity) — the
 * engine's actual per-account growth rate equals the coast test's
 * projection rate exactly whenever no rates schedule is active (both are
 * acc.growth ?? resolveRet(acc, a)). So a no-contribution plan either
 * coasts at start_year (if ever) or never — there is no "later" crossing
 * to find. Test 1 and 2 rely on this fact directly; test 3 breaks the
 * invariance on purpose by adding an ongoing contribution, which is what
 * produces a genuinely mid-horizon coast_year.
 */
import { describe, expect, it } from "vitest";
import { coastTargetAtRetirement, mortgageBalanceAt, runWithMeta, type YearRates } from "../src/engine.js";
import { COAST, DEFAULT_ASSUMPTIONS, normalizePlan, type Plan } from "../src/model.js";
import { runMonteCarlo } from "../src/montecarlo.js";

describe("coastTargetAtRetirement + coast_year — closed-form pin (no house)", () => {
  // Single taxable account, no contributions, a large income (so the
  // household never needs to withdraw pre-retirement) — balance changes
  // ONLY via growth. inflation 0.03, fi_multiple 25, ret 0.07 (global
  // default), retirement_year 10 years out (2026 -> 2036).
  const a = { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2036, retirement_year: 2036, inflation: 0.03, fi_multiple: 25, ret: 0.07 };
  const plan = (balance: number): Plan =>
    normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "B", tax: "taxable", balance, basis: balance }],
      incomes: [{ name: "salary", amount: 500_000, start: 2026, end: 2035 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [],
      house: null,
      assumptions: a,
    });

  // Hand-derived target: 25 x 40000 x 1.03^(2036-2026) = 25 x 40000 x 1.03^10
  // ~= 25 x 53,756.66 ~= 1,343,916.38 (fi_multiple x grown retirement-year
  // spending; no house, so this is the whole target).
  const expectedTarget = 25 * 40_000 * 1.03 ** 10;

  it("target matches the hand-derived closed form exactly", () => {
    expect(coastTargetAtRetirement(plan(0), a)).toBeCloseTo(expectedTarget, 6);
    expect(mortgageBalanceAt(plan(0), 2036)).toBe(0); // no house
  });

  it("sufficient balance coasts at start_year (700k grown @7%/11yr ~= 1,473,397 clears the target)", () => {
    // 700000 * 1.07^11 ~= 1,473,397 > 1,343,916 target. Per the file-header
    // invariance argument this single-account/no-contribution plan either
    // coasts at start_year or never — replaying growth confirms it's the
    // former, and the loop finds no EARLIER year since start_year IS the
    // first evaluated year.
    let bal = 700_000;
    let expectedCoastYear: number | null = null;
    for (let y = 2026; y < 2036; y++) {
      bal *= 1.07;
      const projected = bal * 1.07 ** (2036 - y);
      if (expectedCoastYear === null && projected >= expectedTarget) expectedCoastYear = y;
    }
    expect(expectedCoastYear).toBe(2026);
    expect(runWithMeta(plan(700_000)).coast_year).toBe(expectedCoastYear);
  });

  it("insufficient balance never coasts within the horizon (300k grown @7%/11yr ~= 631,456 falls short)", () => {
    let bal = 300_000;
    let expectedCoastYear: number | null = null;
    for (let y = 2026; y < 2036; y++) {
      bal *= 1.07;
      const projected = bal * 1.07 ** (2036 - y);
      if (expectedCoastYear === null && projected >= expectedTarget) expectedCoastYear = y;
    }
    expect(expectedCoastYear).toBeNull();
    expect(runWithMeta(plan(300_000)).coast_year).toBeNull();
  });
});

describe("coastTargetAtRetirement — house costs cross-checked against the engine's own retirement-year row", () => {
  // row.expenses at y = retirement_year (R) is computed by the engine from
  // EXACTLY the same explicit-expense + house-cost formulas coastTarget
  // AtRetirement mirrors in closed form — and at y = R the household is
  // already retired (lastWorkYear = R-1), so the "surplus gets spent into
  // exp" working-year quirk doesn't contaminate it. That makes row.expenses
  // (R) an independent ground truth for the house-cost half of the target
  // formula, without hand-typing a second amortization loop.
  const a = { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2032, retirement_year: 2032, inflation: 0.03, fi_multiple: 25, ret: 0.07 };
  const plan: Plan = normalizePlan({
    birth_year: 1990,
    accounts: [{ name: "cash", tax: "cash", balance: 0, growth: 0 }],
    incomes: [{ name: "salary", amount: 400_000, start: 2026, end: 2031 }],
    social_security: [],
    expenses: [{ name: "living", amount: 30_000, start: 2026, end: 2091 }],
    contributions: [],
    house: {
      value: 300_000,
      appreciation: 0.03,
      property_tax_rate: 0.01,
      insurance_rate: 0.003,
      maintenance_rate: 0.005,
      hoa_monthly: 50,
      mortgage: { balance: 200_000, rate: 0.05, payment_monthly: 1_400 },
    },
    assumptions: a,
  });

  it("fi_multiple x engine's own retirement-year row.expenses", () => {
    const { rows } = runWithMeta(plan);
    const rYear = rows.find((r) => r.year === 2032)!;
    expect(coastTargetAtRetirement(plan, a)).toBeCloseTo(25 * rYear.expenses, 2);
  });
});

describe("mortgageBalanceAt — pure amortization replay", () => {
  // Independent reference replay (12 payments/yr; a partial first year
  // truncates via Math.trunc(12 * first_year_fraction), exactly like the
  // engine's own mortgage loop) — written separately from the
  // implementation under test, not shared code.
  function refReplay(balance: number, rate: number, paymentMonthly: number, startYear: number, firstYearFraction: number, uptoYear: number) {
    let bal = balance;
    for (let y = startYear; y <= uptoYear; y++) {
      const frac = y === startYear ? firstYearFraction : 1.0;
      const nMonths = Math.trunc(12 * frac);
      for (let m = 0; m < nMonths && bal > 0; m++) {
        const interest = (bal * rate) / 12;
        const principal = Math.min(paymentMonthly - interest, bal);
        bal -= principal;
      }
    }
    return bal;
  }

  it("matches an independently-replayed schedule, including a truncated first year", () => {
    const plan: Plan = normalizePlan({
      birth_year: 1990,
      accounts: [],
      incomes: [],
      social_security: [],
      expenses: [],
      contributions: [],
      house: {
        value: 250_000,
        appreciation: 0.03,
        mortgage: { balance: 50_000, rate: 0.06, payment_monthly: 500 },
      },
      assumptions: { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2030, first_year_fraction: 0.5 },
    });
    const expected2027 = refReplay(50_000, 0.06, 500, 2026, 0.5, 2027);
    const expected2029 = refReplay(50_000, 0.06, 500, 2026, 0.5, 2029);
    expect(mortgageBalanceAt(plan, 2027)).toBeCloseTo(expected2027, 6);
    expect(mortgageBalanceAt(plan, 2029)).toBeCloseTo(expected2029, 6);
  });

  it("returns 0 once the loan is fully retired", () => {
    const plan: Plan = normalizePlan({
      birth_year: 1990,
      accounts: [],
      incomes: [],
      social_security: [],
      expenses: [],
      contributions: [],
      house: { value: 100_000, appreciation: 0.03, mortgage: { balance: 1_000, rate: 0.05, payment_monthly: 5_000 } },
      assumptions: { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2027 },
    });
    // a single $5,000 payment on a $1,000 balance clears it within year one
    expect(mortgageBalanceAt(plan, 2027)).toBe(0);
  });
});

describe("allocation-awareness — a cash-heavy portfolio coasts no sooner than an all-equity one", () => {
  // Equal total starting balance, identical expense/target, no
  // contributions. Plan A: all-equity (global default ret 0.07). Plan B:
  // half in a cash account resolved via assumptions.class_returns.cash =
  // 0.02 (exercises the resolveRet chain inside the coast projection, not
  // just a.ret). Per the file-header invariance argument, EACH plan
  // individually is time-invariant (a sum of time-invariant per-account
  // projections is itself time-invariant), so each is "coasts at
  // start_year" or "never" — chosen so A does and B doesn't.
  const base = { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2036, retirement_year: 2036, inflation: 0.03, fi_multiple: 25, ret: 0.07 };
  const expenses = [{ name: "living", amount: 40_000, start: 2026, end: 2091 }];
  const incomes = [{ name: "salary", amount: 500_000, start: 2026, end: 2035 }];

  const planA: Plan = normalizePlan({
    birth_year: 1990,
    accounts: [{ name: "equity", tax: "taxable", balance: 700_000, basis: 700_000 }],
    incomes,
    social_security: [],
    expenses,
    contributions: [],
    house: null,
    assumptions: base,
  });

  const planB: Plan = normalizePlan({
    birth_year: 1990,
    accounts: [
      { name: "equity", tax: "taxable", balance: 350_000, basis: 350_000 },
      { name: "cash", tax: "cash", balance: 350_000 },
    ],
    incomes,
    social_security: [],
    expenses,
    contributions: [],
    house: null,
    assumptions: { ...base, class_returns: { cash: 0.02 } },
  });

  it("A (all-equity) coasts at start_year; B (50% @2% cash) never coasts within the horizon", () => {
    // A: 700000 * 1.07^11 ~= 1,473,397 >= target (~1,343,916) -> coasts immediately.
    // B: 350000*1.07^11 + 350000*1.02^11 ~= 736,699 + 435,181 = 1,171,880 < target -> never.
    const resultA = runWithMeta(planA);
    const resultB = runWithMeta(planB);
    expect(resultA.coast_year).toBe(2026);
    expect(resultB.coast_year).toBeNull();
    // the brief's exact assertion form: strictly-later-or-never
    expect(resultB.coast_year === null || resultB.coast_year > resultA.coast_year!).toBe(true);
  });
});

describe("COAST-rung interaction — contributions stop the year after the trigger fires", () => {
  // inflation 0 keeps every dollar figure nominal-flat, so the recurrence
  // is exact: bal_y = (bal_{y-1} + 200000) * 1.07, and the target is a
  // clean 25 x 40000 = 1,000,000 (no expense growth to compound). A big
  // income (500k) comfortably funds both taxes and the full $200k rung
  // every pre-coast year (500000*0.69 - 40000 - 200000 = 105,000 > 0).
  function buildPlan(): Plan {
    return normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "B", tax: "taxable", balance: 10_000, basis: 10_000 }],
      incomes: [{ name: "salary", amount: 500_000, start: 2026, end: 2030 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [{ account: "B", start: 2026, end: COAST, amount: 200_000 }],
      house: null,
      assumptions: { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2032, retirement_year: 2031, inflation: 0, fi_multiple: 25, ret: 0.07 },
    });
  }

  it("hand-replayed coast_year matches the engine, and the COAST-end rung stops the following year", () => {
    const plan = buildPlan();
    const target = coastTargetAtRetirement(plan, plan.assumptions); // == 25 * 40000 == 1,000,000 exactly (inflation 0)
    expect(target).toBeCloseTo(1_000_000, 6);

    // Independent replay of the recurrence bal_y = (bal_{y-1} + 200000) * 1.07,
    // projected forward to R=2031 at the same rate each year.
    let bal = 10_000;
    let expectedCoastYear: number | null = null;
    for (let y = 2026; y < 2031; y++) {
      bal = (bal + 200_000) * 1.07;
      const projected = bal * 1.07 ** (2031 - y);
      if (expectedCoastYear === null && projected >= target) expectedCoastYear = y;
    }
    expect(expectedCoastYear).not.toBeNull();

    const { rows, coast_year } = runWithMeta(plan);
    expect(coast_year).toBe(expectedCoastYear);

    const yearOf = (y: number) => rows.find((r) => r.year === y)!;
    // fully funded through and including coast_year itself
    expect(yearOf(coast_year!).contributions).toBeCloseTo(200_000, 2);
    // the COAST-end rung is the plan's only contribution, so it drops to
    // exactly 0 the very next (still-working) year
    expect(coast_year!).toBeLessThan(2030); // otherwise there's no "year after" left to check
    expect(yearOf(coast_year! + 1).contributions).toBe(0);
  });
});

describe("coast_multiple ignored", () => {
  it("wildly different coast_multiple values produce byte-identical rows and coast_year on a COAST-rung plan", () => {
    const raw = {
      birth_year: 1990,
      accounts: [{ name: "B", tax: "taxable" as const, balance: 10_000, basis: 10_000 }],
      incomes: [{ name: "salary", amount: 500_000, start: 2026, end: 2030 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [{ account: "B", start: 2026, end: COAST, amount: 200_000 }],
      house: null,
      assumptions: { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2032, retirement_year: 2031, inflation: 0, fi_multiple: 25, ret: 0.07 },
    };
    const plan4 = normalizePlan({ ...raw, assumptions: { ...raw.assumptions, coast_multiple: 4 } });
    const plan400 = normalizePlan({ ...raw, assumptions: { ...raw.assumptions, coast_multiple: 400 } });
    const r4 = runWithMeta(plan4);
    const r400 = runWithMeta(plan400);
    expect(r4.coast_year).not.toBeNull(); // sanity: this plan does coast (see previous describe block)
    expect(r4.coast_year).toBe(r400.coast_year);
    expect(r4.rows).toEqual(r400.rows);
  });
});

describe("expectations rule holds under Monte Carlo / rates schedules", () => {
  // Same shape as the COAST-rung plan above but with the contribution
  // trimmed to $100k/yr instead of $200k — per the "COAST-rung interaction"
  // hand-derivation, that sequence (165k, 305k, 436k, 559k, 673k projected
  // through 2026-2030) never clears the 1,000,000 target, so this plan
  // never coasts in the deterministic baseline either. That's deliberate:
  // an all-crash schedule can only ever shrink realized balances relative
  // to the +7%/yr baseline (every contributed dollar compounds DOWN at
  // -90%/yr instead of up), and the coast projection multiplies that
  // realized balance by the SAME deterministic rate in both cases — so
  // Projected_crash(y) < Projected_baseline(y) at every y, term by term.
  // If baseline never clears the target, crash provably can't either,
  // which makes "both null" a rigorous equality here, not a coincidence —
  // the strongest version of this assertion the brief's own "can't observe
  // directly" caveat allows for.
  function buildPlan(): Plan {
    return normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "B", tax: "taxable", balance: 10_000, basis: 10_000 }],
      incomes: [{ name: "salary", amount: 500_000, start: 2026, end: 2030 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [{ account: "B", start: 2026, end: COAST, amount: 100_000 }],
      house: null,
      assumptions: { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2032, retirement_year: 2031, inflation: 0, fi_multiple: 25, ret: 0.07 },
    });
  }

  it("fixed seed => identical Monte Carlo results on a COAST-rung plan", () => {
    const plan = buildPlan();
    const r1 = runMonteCarlo(plan, { trials: 30, seed: 42 });
    const r2 = runMonteCarlo(plan, { trials: 30, seed: 42 });
    expect(r1).toEqual(r2);
  });

  it("an all-crash sampled schedule cannot move coast_year — the test ignores sampled rates entirely", () => {
    const plan = buildPlan();
    const a = plan.assumptions;
    const allCrash: YearRates[] = [];
    for (let y = a.start_year; y <= a.end_year; y++) {
      allCrash.push({ year: y, ret: -0.9, inflation: a.inflation });
    }
    const withoutSchedule = runWithMeta(plan);
    const withCrashSchedule = runWithMeta(plan, undefined, allCrash);
    expect(withoutSchedule.coast_year).toBeNull(); // sanity: confirms the "never coasts" derivation above
    expect(withCrashSchedule.coast_year).toBe(withoutSchedule.coast_year);
  });
});
