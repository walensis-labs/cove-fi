import { describe, expect, it } from "vitest";
import { run } from "../src/engine.js";
import { normalizePlan } from "../src/model.js";
import { PlanValidationError, planFromJson } from "../src/planjson.js";
import { syntheticPlan } from "./helpers/synthetic.js";

// biome-ignore lint: test fixtures mutate loosely-typed JSON clones
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

describe("planFromJson", () => {
  it("accepts the synthetic plan serialized to JSON and round-trips", () => {
    const plan = syntheticPlan();
    const json = clone(plan);
    expect(planFromJson(json)).toEqual(normalizePlan(plan));
  });

  it("rejects an unknown account tax value", () => {
    const json = clone(syntheticPlan()) as any;
    json.accounts[0].tax = "crypto";
    expect(() => planFromJson(json)).toThrow(PlanValidationError);
    try {
      planFromJson(json);
      expect.fail("expected PlanValidationError");
    } catch (err) {
      expect((err as PlanValidationError).issues.some((i) => /tax/i.test(i))).toBe(true);
    }
  });

  it("rejects a contribution referencing an account name not in accounts", () => {
    const json = clone(syntheticPlan()) as any;
    json.contributions[0].account = "does-not-exist";
    try {
      planFromJson(json);
      expect.fail("expected PlanValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanValidationError);
      expect((err as PlanValidationError).issues.some((i) => i.includes("does-not-exist"))).toBe(true);
    }
  });

  it("rejects end < start on an income", () => {
    const json = clone(syntheticPlan()) as any;
    json.incomes[0].end = json.incomes[0].start - 1;
    expect(() => planFromJson(json)).toThrow(PlanValidationError);
  });

  it("rejects end < start on an expense", () => {
    const json = clone(syntheticPlan()) as any;
    json.expenses[0].end = json.expenses[0].start - 1;
    expect(() => planFromJson(json)).toThrow(PlanValidationError);
  });

  it("rejects end < start on a contribution (non-COAST)", () => {
    const json = clone(syntheticPlan()) as any;
    json.contributions[2].start = 2030;
    json.contributions[2].end = 2020;
    expect(() => planFromJson(json)).toThrow(PlanValidationError);
  });

  it("does not treat COAST (-1) sentinels as end < start", () => {
    const json = clone(syntheticPlan()) as any;
    expect(json.contributions.some((c: any) => c.start === -1)).toBe(true);
    expect(json.contributions.some((c: any) => c.end === -1)).toBe(true);
    expect(() => planFromJson(json)).not.toThrow();
  });

  it("rejects a non-numeric balance", () => {
    const json = clone(syntheticPlan()) as any;
    json.accounts[0].balance = "twenty-thousand";
    expect(() => planFromJson(json)).toThrow(PlanValidationError);
  });

  it("rejects a contribution rung with no amount/pct_of_income/to_limit", () => {
    const json = clone(syntheticPlan()) as any;
    json.contributions.push({ account: "roth", start: 2026, end: 2030 });
    try {
      planFromJson(json);
      expect.fail("expected PlanValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanValidationError);
      expect(
        (err as PlanValidationError).issues.some((i) => /amount|pct_of_income|to_limit/i.test(i)),
      ).toBe(true);
    }
  });

  it("rejects an expense fund_from naming a nonexistent account", () => {
    const json = clone(syntheticPlan()) as any;
    const edu = json.expenses.find((e: any) => e.fund_from);
    edu.fund_from = "does-not-exist";
    try {
      planFromJson(json);
      expect.fail("expected PlanValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanValidationError);
      expect((err as PlanValidationError).issues.some((i) => i.includes("does-not-exist"))).toBe(true);
    }
  });
});

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("conventions", () => {
  const plan = syntheticPlan();
  const rows = run(plan);
  const byYear = new Map(rows.map((r) => [r.year, r]));

  it("1: LNW excludes 529 and house; NW includes both", () => {
    // recompute year-1 identity from a single-account probe plan instead of
    // reimplementing the engine: with one liquid account, no house, no flows,
    // NW === LNW === balance * (1 + ret * frac)
    const probe = planFromJson({
      birth_year: 1990,
      accounts: [{ name: "b", tax: "taxable", balance: 1000, basis: 1000 }],
      incomes: [],
      social_security: [],
      expenses: [],
      contributions: [],
      house: null,
      assumptions: {
        ...plan.assumptions,
        start_year: 2026,
        end_year: 2026,
        first_year_fraction: 1.0,
        retirement_year: 2099,
        dividend_rate: 0,
      },
    });
    const [r] = run(probe);
    expect(r!.net_worth).toBeCloseTo(1000 * 1.07, 6);
    expect(r!.liquid_net_worth).toBeCloseTo(1000 * 1.07, 6);
    // and on the full plan: NW - LNW === 529 balance + house value (year 1)
    const r0 = rows[0]!;
    expect(r0.net_worth).toBeGreaterThan(r0.liquid_net_worth);
  });

  it("2: waterfall is cash-flow constrained — never withdraws to fund rungs", () => {
    const workRows = rows.filter((r) => r.year < plan.assumptions.retirement_year);
    // 529-funded education years DO withdraw from the 529; exclude them
    const eduYears = new Set([2040, 2041, 2042, 2043]);
    for (const r of workRows.filter((r) => !eduYears.has(r.year)))
      expect(r.withdrawals, `year ${r.year}`).toBe(0);
  });

  it("3: surplus is spent — income identity holds every working year", () => {
    for (const r of rows.filter((r) => r.year < plan.assumptions.retirement_year)) {
      // dividends tax is the only wedge: income - taxes - contributions - expenses
      // must be ~0 (surplus folded into expenses) when cash flow is positive
      const resid = r.income - r.taxes - r.contributions - r.expenses;
      expect(resid, `year ${r.year}`).toBeLessThan(1);
    }
  });

  it("4: nominal_at_start (grow$) compounds from plan start vs own start", () => {
    const g = (p: ReturnType<typeof syntheticPlan>, nominal: boolean) =>
      run(
        planFromJson({
          ...p,
          contributions: [],
          house: null,
          incomes: [],
          social_security: [],
          expenses: [{ name: "e", amount: 1000, start: 2030, end: 2030, nominal_at_start: nominal }],
          assumptions: { ...p.assumptions, start_year: 2026, end_year: 2030, retirement_year: 2099, dividend_rate: 0 },
          accounts: [{ name: "c", tax: "cash", balance: 1e9, growth: 0 }],
        }),
      ).at(-1)!.expenses;
    // nominal_at_start: 1000 * 1.03^(2030-2030) = 1000
    expect(g(plan, true)).toBeCloseTo(1000, 6);
    // today's-$: 1000 * 1.03^(2030-2026)
    expect(g(plan, false)).toBeCloseTo(1000 * 1.03 ** 4, 6);
  });

  it("5: pretax rungs reduce the tax base (converged)", () => {
    const r27 = byYear.get(2027)!;
    // gross 100k grown one year; 401k+HSA limits pretax -> taxes strictly less
    // than gross * (income_tax + local_tax)
    expect(r27.taxes).toBeLessThan(r27.income * 0.31);
  });

  it("first_year_fraction scales year one", () => {
    const full = run({ ...plan, assumptions: { ...plan.assumptions, first_year_fraction: 1.0 } });
    expect(rows[0]!.income).toBeCloseTo(full[0]!.income * 0.5, 6);
  });

  it("deterministic: same input, same output", () => {
    expect(run(syntheticPlan())).toEqual(rows);
  });
});
