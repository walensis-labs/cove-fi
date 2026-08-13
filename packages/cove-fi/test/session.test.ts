import { describe, expect, it } from "vitest";
import { IRS_LIMITS_2026 } from "../src/model.js";
import { applyOverrides, Session } from "../src/session.js";
import { syntheticPlan } from "./helpers/synthetic.js";

/** Recursively Object.freeze every plain object/array reachable from v. */
function deepFreeze<T>(v: T): T {
  if (v !== null && (typeof v === "object" || Array.isArray(v))) {
    for (const k of Object.keys(v as object)) {
      deepFreeze((v as Record<string, unknown>)[k]);
    }
    Object.freeze(v);
  }
  return v;
}

describe("applyOverrides — purity", () => {
  it("never mutates the input plan (deep-frozen input survives every override kind)", () => {
    const frozen = deepFreeze(syntheticPlan());
    expect(() =>
      applyOverrides(frozen, {
        retirement_year: 2045,
        inflation: 0.04,
        ret: 0.08,
        savings_rate_multiplier: 0.5,
        ss_haircut: 0.6,
        ss_claim_year: 2065,
        extra_expenses: [{ name: "extra", amount: 1000, start: 2030, end: 2035 }],
        extra_incomes: [{ name: "side", amount: 5000, start: 2026, end: 2030 }],
        class_returns: { cash: 0.02, taxable: 0.05 },
      }),
    ).not.toThrow();
  });

  it("returns a deep copy, not the same object graph", () => {
    const plan = syntheticPlan();
    const copy = applyOverrides(plan, {});
    expect(copy).not.toBe(plan);
    expect(copy.assumptions).not.toBe(plan.assumptions);
    expect(copy.contributions).not.toBe(plan.contributions);
    expect(copy).toEqual(plan);
  });
});

describe("applyOverrides — assumption-level overrides", () => {
  it("writes retirement_year/inflation/ret into the copied plan's assumptions", () => {
    const plan = syntheticPlan();
    const out = applyOverrides(plan, { retirement_year: 2045, inflation: 0.04, ret: 0.08 });
    expect(out.assumptions.retirement_year).toBe(2045);
    expect(out.assumptions.inflation).toBe(0.04);
    expect(out.assumptions.ret).toBe(0.08);
    // base plan's assumptions unaffected
    expect(plan.assumptions.retirement_year).toBe(2050);
  });
});

describe("applyOverrides — class_returns", () => {
  it("replaces the whole map wholesale, not a per-key merge", () => {
    const plan = syntheticPlan();
    plan.assumptions.class_returns = { cash: 0.02, taxable: 0.03 };
    const out = applyOverrides(plan, { class_returns: { roth: 0.09 } });
    expect(out.assumptions.class_returns).toEqual({ roth: 0.09 });
  });

  it("leaves assumptions.class_returns absent when the plan has none and no override is given", () => {
    const plan = syntheticPlan();
    const out = applyOverrides(plan, {});
    expect(out.assumptions.class_returns).toBeUndefined();
  });

  it("does not alias the override's class_returns object into the returned plan", () => {
    const plan = syntheticPlan();
    const o = { class_returns: { cash: 0.02 } };
    const out = applyOverrides(plan, o);
    out.assumptions.class_returns!.cash = 0.99;
    expect(o.class_returns.cash).toBe(0.02);
  });
});

describe("applyOverrides — savings_rate_multiplier", () => {
  it("scales amount and pct_of_income on every contribution rung", () => {
    const plan = syntheticPlan();
    const out = applyOverrides(plan, { savings_rate_multiplier: 0.5 });
    for (let i = 0; i < plan.contributions.length; i++) {
      const before = plan.contributions[i]!;
      const after = out.contributions[i]!;
      if (before.to_limit && before.annual_limit_key) continue; // covered below
      if (before.amount != null) {
        expect(after.amount).toBeCloseTo(before.amount * 0.5);
      }
      if (before.pct_of_income != null) {
        expect(after.pct_of_income).toBeCloseTo(before.pct_of_income * 0.5);
      }
    }
  });

  it("converts to_limit rungs to a fixed amount = IRS limit * multiplier, and drops to_limit", () => {
    const plan = syntheticPlan();
    const out = applyOverrides(plan, { savings_rate_multiplier: 0.5 });
    const before401k = plan.contributions.find((c) => c.to_limit && c.annual_limit_key === "401k")!;
    const idx = plan.contributions.indexOf(before401k);
    const after401k = out.contributions[idx]!;
    expect(after401k.to_limit).toBe(false);
    expect(after401k.amount).toBeCloseTo(IRS_LIMITS_2026["401k"] * 0.5);

    const beforeHsa = plan.contributions.find((c) => c.to_limit && c.annual_limit_key === "hsa_family")!;
    const idxHsa = plan.contributions.indexOf(beforeHsa);
    const afterHsa = out.contributions[idxHsa]!;
    expect(afterHsa.to_limit).toBe(false);
    expect(afterHsa.amount).toBeCloseTo(IRS_LIMITS_2026.hsa_family * 0.5);
  });
});

describe("applyOverrides — social security", () => {
  it("maps ss_haircut and ss_claim_year onto every SocialSecurity entry", () => {
    const plan = syntheticPlan();
    const out = applyOverrides(plan, { ss_haircut: 0.6, ss_claim_year: 2065 });
    expect(out.social_security.length).toBeGreaterThan(0);
    for (const ss of out.social_security) {
      expect(ss.haircut).toBe(0.6);
      expect(ss.claim_year).toBe(2065);
    }
  });
});

describe("applyOverrides — extra events append", () => {
  it("appends extra_expenses and extra_incomes without dropping existing entries", () => {
    const plan = syntheticPlan();
    const extraExpense = { name: "sabbatical", amount: 20000, start: 2030, end: 2031 };
    const extraIncome = { name: "consulting", amount: 15000, start: 2030, end: 2031 };
    const out = applyOverrides(plan, { extra_expenses: [extraExpense], extra_incomes: [extraIncome] });
    expect(out.expenses.length).toBe(plan.expenses.length + 1);
    expect(out.incomes.length).toBe(plan.incomes.length + 1);
    expect(out.expenses.at(-1)).toEqual(extraExpense);
    expect(out.incomes.at(-1)).toEqual(extraIncome);
  });
});

describe("Session — runProjection / todays conversion", () => {
  it("todays[0] equals rows[0] nominally (inflation factor is 1 at start_year)", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    const { rows, todays } = session.runProjection();
    expect(rows.length).toBe(todays.length);
    expect(todays[0]!.year).toBe(rows[0]!.year);
    for (const k of ["net_worth", "liquid_net_worth", "income", "expenses", "taxes", "withdrawals", "contributions"] as const) {
      expect(todays[0]![k]).toBeCloseTo(rows[0]![k], 6);
    }
  });

  it("deflates a later year by (1+inflation)^(year-start_year)", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    const { rows, todays } = session.runProjection();
    const a = syntheticPlan().assumptions;
    const lastIdx = rows.length - 1;
    const factor = (1 + a.inflation) ** (rows[lastIdx]!.year - a.start_year);
    expect(todays[lastIdx]!.net_worth).toBeCloseTo(rows[lastIdx]!.net_worth / factor, 4);
  });
});

describe("Session — fiStatus directional assertions on syntheticPlan", () => {
  it("retiring later does not lower terminal net worth vs base", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    const base = session.fiStatus();
    session.defineScenario("later", { retirement_year: 2055 });
    const later = session.fiStatus("later");
    expect(later.terminal_net_worth).toBeGreaterThanOrEqual(base.terminal_net_worth);
    expect(later.retirement_year).toBe(2055);
  });

  it("retiring earlier does not raise terminal net worth vs base, and depletes savings sooner", () => {
    // On this synthetic plan both the base (2050) and earlier (2045)
    // retirement dates fully deplete liquid net worth well before
    // end_year — after that, net worth is house-equity-only and
    // retirement-year-invariant, so terminal net worth alone converges
    // to the same floor. depletion_year is the metric that still shows
    // the strict effect: earlier retirement burns through savings sooner.
    const session = new Session();
    session.plan = syntheticPlan();
    const base = session.fiStatus();
    session.defineScenario("earlier", { retirement_year: 2045 });
    const earlier = session.fiStatus("earlier");
    expect(earlier.terminal_net_worth).toBeLessThanOrEqual(base.terminal_net_worth);
    expect(earlier.retirement_year).toBe(2045);
    expect(base.depletion_year).not.toBeNull();
    expect(earlier.depletion_year).not.toBeNull();
    expect(earlier.depletion_year!).toBeLessThan(base.depletion_year!);
  });

  it("terminal_net_worth_todays deflates the last row by its own year", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    const status = session.fiStatus();
    const { rows } = session.runProjection();
    const a = syntheticPlan().assumptions;
    const last = rows.at(-1)!;
    const factor = (1 + a.inflation) ** (last.year - a.start_year);
    expect(status.terminal_net_worth_todays).toBeCloseTo(last.net_worth / factor, 4);
    expect(status.terminal_net_worth).toBeCloseTo(last.net_worth, 6);
  });
});

describe("Session — error paths", () => {
  it("throws a clear error when no plan is loaded", () => {
    const session = new Session();
    expect(() => session.runProjection()).toThrowError(/no plan loaded/i);
    expect(() => session.fiStatus()).toThrowError(/no plan loaded/i);
  });

  it("throws a clear error for an unknown scenario name", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    expect(() => session.runProjection("does-not-exist")).toThrowError(/scenario/i);
    expect(() => session.fiStatus("does-not-exist")).toThrowError(/scenario/i);
  });

  it("compareScenarios throws a clear error for an unknown name", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    session.defineScenario("known", { retirement_year: 2045 });
    expect(() => session.compareScenarios(["known", "unknown"])).toThrowError(/scenario/i);
  });
});

describe("Session — monteCarlo", () => {
  it("fixed seed => identical results across two calls", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    const r1 = session.monteCarlo(undefined, 50, 7);
    const r2 = session.monteCarlo(undefined, 50, 7);
    expect(r1).toEqual(r2);
  });

  it("a scenario overlay changes the result vs the base plan", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    session.defineScenario("later", { retirement_year: 2055 });
    const base = session.monteCarlo(undefined, 50, 7);
    const later = session.monteCarlo("later", 50, 7);
    expect(later).not.toEqual(base);
  });

  it("throws a clear error when no plan is loaded", () => {
    const session = new Session();
    expect(() => session.monteCarlo()).toThrowError(/no plan loaded/i);
  });

  it("throws a clear error for an unknown scenario name", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    expect(() => session.monteCarlo("does-not-exist")).toThrowError(/scenario/i);
  });
});

describe("Session — compareScenarios", () => {
  it("computes deltas relative to the FIRST name in names", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    session.defineScenario("base", {});
    session.defineScenario("later", { retirement_year: 2055 });
    const cmp = session.compareScenarios(["base", "later"]);
    expect(cmp.series.base).toBeDefined();
    expect(cmp.series.later).toBeDefined();
    expect(cmp.deltas.base!.terminal_delta).toBeCloseTo(0, 6);
    expect(cmp.deltas.base!.fi_year_delta === null || cmp.deltas.base!.fi_year_delta === 0).toBe(true);
    const baseStatus = session.fiStatus("base");
    const laterStatus = session.fiStatus("later");
    expect(cmp.deltas.later!.terminal_delta).toBeCloseTo(laterStatus.terminal_net_worth - baseStatus.terminal_net_worth, 4);
    expect(cmp.years.length).toBe(cmp.series.base!.length);
  });
});
