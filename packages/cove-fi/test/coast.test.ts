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

describe("coast projection RATE and TARGET are deterministic; realized balances are path-dependent", () => {
  // Revision note: an earlier version of this describe block asserted
  // "all-crash schedule cannot change coast_year" using a plan that never
  // coasts in EITHER the baseline or the crash run — that assertion is
  // mutation-vacuous (null === null passes regardless of whether the
  // projection rate correctly stays deterministic or incorrectly leaks the
  // schedule's rate; a deliberately-broken implementation that projects at
  // the crashed rate instead of the deterministic one still returns null
  // here, for the same "never clears the target" reason). The actual
  // invariant the expectations rule promises is narrower and it's this
  // block's title: the coast test's PROJECTION RATE (coastGrowthRate) and
  // TARGET (coastTargetAtRetirement) never consult a rates schedule — but
  // the REALIZED BALANCE fed into that projection is whatever the trial
  // actually simulated, schedule included. So a crash CAN legitimately
  // move coast_year later (or to null) by shrinking realized balances;
  // what it can never do is change the RATE used to project them forward,
  // or the TARGET they're compared against.

  it("discriminating pin: coast_year on crashed realized balances, projected at the DETERMINISTIC class_returns rate — a schedule-leaking projection would return null instead", () => {
    // Account "T": resolveRet resolves to class_returns.taxable = 0.06 (no
    // acc.ret/acc.growth override, so a schedule dominates the ACTUAL
    // simulated growth per the existing "rates schedule dominates ret/
    // class_returns" rule — see class-returns.test.ts). All-crash schedule:
    // ret = -0.5 every year, inflation pinned to a.inflation (0.03) so the
    // target/expense side is untouched by the schedule at all.
    //
    // Same target as the closed-form pin above: 25 x 40000 x 1.03^10 ~=
    // 1,343,916.38 (R = 2036, 10 years out).
    //
    // Realized balance under the crash: bal_y = B0 x 0.5^(y-2025) (a -50%
    // haircut applied once per year, 2026..y inclusive). A CORRECT coast
    // test projects that realized balance forward to R at the deterministic
    // 0.06 rate: Projected(y) = bal_y x 1.06^(R-y). B0 = 2,000,000 is sized
    // so this clears the target at y = 2026 (the very first evaluated year):
    // bal_2026 = 2,000,000 x 0.5 = 1,000,000; Projected(2026) = 1,000,000 x
    // 1.06^10 ~= 1,790,847 > 1,343,916.
    //
    // A LEAKING implementation that projects at the schedule's -0.5 instead
    // of the deterministic 0.06 would compute Projected_leak(y) = bal_y x
    // 0.5^(R-y) = B0 x 0.5^(R-2025) — CONSTANT across y (same rate both
    // segments, per the file-header invariance argument) at 2,000,000 x
    // 0.5^11 ~= 976.56, nowhere near the target for ANY y — i.e. it would
    // return null instead of 2026. That gap is what this pin discriminates.
    const a = { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2036, retirement_year: 2036, inflation: 0.03, fi_multiple: 25, class_returns: { taxable: 0.06 } };
    const plan: Plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "T", tax: "taxable", balance: 2_000_000, basis: 2_000_000 }],
      incomes: [{ name: "salary", amount: 200_000, start: 2026, end: 2035 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [],
      house: null,
      assumptions: a,
    });
    const target = coastTargetAtRetirement(plan, a);

    const allCrash: YearRates[] = [];
    for (let y = a.start_year; y <= a.end_year; y++) allCrash.push({ year: y, ret: -0.5, inflation: a.inflation });

    // Independent hand replay: realized balance follows the CRASH schedule
    // (-0.5/yr); projection uses the DETERMINISTIC class_returns rate
    // (0.06) — exactly the rule under test, computed separately from the
    // engine.
    let bal = 2_000_000;
    let expectedCoastYear: number | null = null;
    for (let y = 2026; y < 2036; y++) {
      bal *= 1 - 0.5;
      const projected = bal * 1.06 ** (2036 - y);
      if (expectedCoastYear === null && projected >= target) expectedCoastYear = y;
    }
    expect(expectedCoastYear).toBe(2026);

    const { coast_year } = runWithMeta(plan, undefined, allCrash);
    expect(coast_year).toBe(expectedCoastYear); // fails (null) on a schedule-leaking projection
  });

  it("target invariance: coastTargetAtRetirement is bit-identical before and after a schedule-driven run of the same plan", () => {
    // coastTargetAtRetirement doesn't take a rates parameter at all, so
    // this is really a purity/no-side-effect check: running the plan
    // through an all-crash schedule must not mutate plan/assumptions (or
    // touch any module-level state) in a way that would change what the
    // target function — called completely independently afterward —
    // computes.
    const a = { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2036, retirement_year: 2036, inflation: 0.03, fi_multiple: 25 };
    const plan: Plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "T", tax: "taxable", balance: 100_000, basis: 100_000 }],
      incomes: [{ name: "salary", amount: 200_000, start: 2026, end: 2035 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [],
      house: null,
      assumptions: a,
    });
    const allCrash: YearRates[] = [];
    for (let y = a.start_year; y <= a.end_year; y++) allCrash.push({ year: y, ret: -0.5, inflation: a.inflation });

    const targetBefore = coastTargetAtRetirement(plan, a);
    runWithMeta(plan, undefined, allCrash);
    const targetAfter = coastTargetAtRetirement(plan, a);
    expect(targetAfter).toBe(targetBefore);
  });

  it("path-dependence acknowledged: an all-crash schedule on the $200k-rung plan moves coast_year later-or-null, never earlier", () => {
    // Reuses the exact plan from "COAST-rung interaction" above, where the
    // deterministic baseline coasts at 2029. Every contributed dollar
    // compounds DOWN under the crash (-0.9/yr) instead of up (+0.07/yr,
    // baseline), so realized balances are strictly smaller at every y under
    // the crash than the baseline — and the projection multiplies by the
    // SAME deterministic rate in both cases — so Projected_crash(y) <
    // Projected_baseline(y) pointwise for every y. Crash can only push the
    // first crossing later (or eliminate it), never earlier.
    const plan: Plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "B", tax: "taxable", balance: 10_000, basis: 10_000 }],
      incomes: [{ name: "salary", amount: 500_000, start: 2026, end: 2030 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [{ account: "B", start: 2026, end: COAST, amount: 200_000 }],
      house: null,
      assumptions: { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2032, retirement_year: 2031, inflation: 0, fi_multiple: 25, ret: 0.07 },
    });
    const a = plan.assumptions;
    const allCrash: YearRates[] = [];
    for (let y = a.start_year; y <= a.end_year; y++) allCrash.push({ year: y, ret: -0.9, inflation: a.inflation });

    const baseline = runWithMeta(plan).coast_year;
    expect(baseline).not.toBeNull(); // sanity: matches the "COAST-rung interaction" derivation (2029)
    const crashed = runWithMeta(plan, undefined, allCrash).coast_year;
    expect(crashed === null || crashed > baseline!).toBe(true);
  });

  it("fixed seed => identical Monte Carlo results on a COAST-rung plan", () => {
    const plan: Plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "B", tax: "taxable", balance: 10_000, basis: 10_000 }],
      incomes: [{ name: "salary", amount: 500_000, start: 2026, end: 2030 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [{ account: "B", start: 2026, end: COAST, amount: 100_000 }],
      house: null,
      assumptions: { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2032, retirement_year: 2031, inflation: 0, fi_multiple: 25, ret: 0.07 },
    });
    const r1 = runMonteCarlo(plan, { trials: 30, seed: 42 });
    const r2 = runMonteCarlo(plan, { trials: 30, seed: 42 });
    expect(r1).toEqual(r2);
  });
});

describe("coastGrowthRate resolution — dedicated acc.growth and class_returns branch coverage", () => {
  // Both cases: same target as the closed-form pin (25 x 40000 x 1.03^10 ~=
  // 1,343,916.38, R = 2036), a single nonzero-balance account with no
  // contributions, sized so the CORRECT rate clears the target at
  // start_year while the WRONG fallback rate (a.ret = 0.07) would not —
  // i.e. each test fails if coastGrowthRate's branch under test were
  // accidentally skipped in favor of the a.ret fallback.
  const a = { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2036, retirement_year: 2036, inflation: 0.03, fi_multiple: 25, ret: 0.07 };
  const target = 25 * 40_000 * 1.03 ** 10;
  const expenses = [{ name: "living", amount: 40_000, start: 2026, end: 2091 }];
  const incomes = [{ name: "salary", amount: 200_000, start: 2026, end: 2035 }];

  it("acc.growth (legacy field) takes absolute precedence, even with a nonzero balance", () => {
    // 550,000 @ 10% (acc.growth) clears (550000*1.10^11 ~= 1,569,214 >=
    // target) but @ 7% (a.ret, the wrong fallback) would NOT (550000*1.07^11
    // ~= 1,157,668 < target).
    const plan: Plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "G", tax: "taxable", balance: 550_000, basis: 550_000, growth: 0.1 }],
      incomes,
      social_security: [],
      expenses,
      contributions: [],
      house: null,
      assumptions: a,
    });
    expect(runWithMeta(plan).coast_year).toBe(2026);
  });

  it("assumptions.class_returns[tax] resolves through resolveRet when no acc.ret/growth override is set", () => {
    // 580,000 @ 9% (class_returns.taxable) clears (580000*1.09^11 ~=
    // 1,496,647 >= target) but @ 7% (a.ret, the wrong fallback) would NOT
    // (580000*1.07^11 ~= 1,220,814 < target).
    const plan: Plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "C", tax: "taxable", balance: 580_000, basis: 580_000 }],
      incomes,
      social_security: [],
      expenses,
      contributions: [],
      house: null,
      assumptions: { ...a, class_returns: { taxable: 0.09 } },
    });
    expect(runWithMeta(plan).coast_year).toBe(2026);
  });
});

describe("mortgageBalanceAt — merged-assumptions bug fix (runWithMeta must not replay from stale plan defaults under an override)", () => {
  // Fixed: mortgageBalanceAt used to always replay from the PLAN's own
  // (unmerged) start_year/first_year_fraction, even when called from
  // runWithMeta with a scenario's merged `a` — so an overridden start_year
  // would desync the coast-netting replay from the rest of the run (whose
  // mortgage amortization is driven by the merged start_year). The
  // optional third `assumptions` argument fixes this; this pins that it's
  // actually threaded through, not just accepted and ignored.
  const plan: Plan = normalizePlan({
    birth_year: 1990,
    accounts: [],
    incomes: [],
    social_security: [],
    expenses: [],
    contributions: [],
    house: { value: 300_000, appreciation: 0.03, mortgage: { balance: 100_000, rate: 0.05, payment_monthly: 700 } },
    assumptions: { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2035, first_year_fraction: 1.0 },
  });

  function refReplay(startYear: number, uptoYear: number): number {
    let bal = 100_000;
    for (let y = startYear; y <= uptoYear; y++) {
      for (let m = 0; m < 12 && bal > 0; m++) {
        const interest = (bal * 0.05) / 12;
        const principal = Math.min(700 - interest, bal);
        bal -= principal;
      }
    }
    return bal;
  }

  it("an overridden start_year (2028) replays 2 fewer years than the plan default (2026), leaving a strictly higher balance at the same target year", () => {
    const atPlanDefault = mortgageBalanceAt(plan, 2030); // replays 2026..2030 (5 years)
    const atOverriddenStart = mortgageBalanceAt(plan, 2030, { ...plan.assumptions, start_year: 2028 }); // replays 2028..2030 (3 years)
    expect(atOverriddenStart).toBeGreaterThan(atPlanDefault);
    expect(atOverriddenStart).toBeCloseTo(refReplay(2028, 2030), 6);
    expect(atPlanDefault).toBeCloseTo(refReplay(2026, 2030), 6);
  });
});

describe("coastTargetAtRetirement — fund_from (529) exclusion, including the documented under-funded-529 limitation", () => {
  // "college" is fund_from-drawn from a 529 seeded with only $5,000 —
  // it drains within the expense's first active year (2030) and stays
  // empty, so by retirement_year (2035) the engine's OWN row.expenses
  // includes the full shortfall as real household cash flow (the 529
  // covers none of it that year). coastTargetAtRetirement excludes the
  // fund_from expense unconditionally regardless — this pins that
  // documented gap, it does not fix it (see engine.ts's doc comment).
  const a = { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2035, retirement_year: 2035, inflation: 0.03, fi_multiple: 25 };
  const plan: Plan = normalizePlan({
    birth_year: 1990,
    accounts: [{ name: "college529", tax: "529", balance: 5_000, liquid: false }],
    incomes: [{ name: "salary", amount: 100_000, start: 2026, end: 2034 }],
    social_security: [],
    expenses: [
      { name: "living", amount: 20_000, start: 2026, end: 2091 },
      { name: "college", amount: 10_000, start: 2030, end: 2040, fund_from: "college529" },
    ],
    contributions: [],
    house: null,
    assumptions: a,
  });

  it("target excludes the fund_from expense entirely, even though the 529 is long depleted by R and the engine's own row.expenses includes the full shortfall", () => {
    const { rows } = runWithMeta(plan);
    const rYear = rows.find((r) => r.year === 2035)!;

    // The 529 (grown at a.ret=0.07 from 2026) is far too small to cover
    // even year one (2030) of a $10k/yr draw, so every year from 2030
    // onward — including 2035 — the FULL grown amount is unfunded shortfall
    // baked into row.expenses.
    const livingGrownAtR = 20_000 * 1.03 ** (2035 - 2026);
    const collegeGrownAtR = 10_000 * 1.03 ** (2035 - 2026); // same today's-$ convention as living
    expect(rYear.expenses).toBeCloseTo(livingGrownAtR + collegeGrownAtR, 2);

    // coastTargetAtRetirement's implied spend = target / fi_multiple —
    // matches ONLY the living expense, confirming college is excluded
    // wholesale (not partially, not at all), regardless of 529 depletion.
    const impliedSpend = coastTargetAtRetirement(plan, a) / a.fi_multiple;
    expect(impliedSpend).toBeCloseTo(livingGrownAtR, 2);
    expect(impliedSpend).toBeLessThan(rYear.expenses); // the documented understatement
  });
});
