import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run, type YearRates } from "../src/engine.js";
import { DEFAULT_ASSUMPTIONS, normalizePlan, resolveRet } from "../src/model.js";
import { planFromJson } from "../src/planjson.js";

const golden = (f: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "golden", f), "utf8"));

describe("golden backward compatibility", () => {
  it("plans without new fields are byte-identical to 0.3.0", () => {
    const rows = run(planFromJson(golden("golden-plan.json")));
    expect(rows).toEqual(golden("golden-rows.json"));  // exact, not toBeCloseTo
  });
});

describe("resolveRet precedence", () => {
  const a = { ret: 0.07, class_returns: { cash: 0.035 } } as never;
  it("account override wins", () =>
    expect(resolveRet({ name: "x", tax: "cash", balance: 0, ret: 0.05 } as never, a)).toBe(0.05));
  it("class default second", () =>
    expect(resolveRet({ name: "x", tax: "cash", balance: 0 } as never, a)).toBe(0.035));
  it("global fallback last", () =>
    expect(resolveRet({ name: "x", tax: "taxable", balance: 0 } as never, a)).toBe(0.07));
});

describe("validation", () => {
  const base = () => golden("golden-plan.json");
  it("rejects out-of-range rates listing every offender", () => {
    const p = base();
    p.accounts[0].ret = 0.9; p.accounts[1].ret = -0.9;
    expect(() => planFromJson(p)).toThrowError(new RegExp(`${p.accounts[0].name}[\\s\\S]*${p.accounts[1].name}`));
  });
  it("rejects unknown class_returns keys", () => {
    const p = base(); p.assumptions.class_returns = { stonks: 0.1 };
    expect(() => planFromJson(p)).toThrowError(/stonks/);
  });
  it("accepts and round-trips valid fields through TOML", async () => {
    const { dumpPlan, loadPlan } = await import("../src/planfile.js");
    const p = base(); p.assumptions.class_returns = { cash: 0.035 }; p.accounts[0].ret = 0.05;
    const back = loadPlan(dumpPlan(planFromJson(p)));
    expect(back.assumptions.class_returns).toEqual({ cash: 0.035 });
    expect(back.accounts[0].ret).toBe(0.05);
  });
});

describe("per-class growth + gated cash tax", () => {
  const probe = (accs: object[], assum: object = {}) => planFromJson({
    birth_year: 1990, accounts: accs, incomes: [], social_security: [],
    expenses: [], contributions: [], house: null,
    assumptions: { start_year: 2026, end_year: 2028, first_year_fraction: 1,
      retirement_year: 2099, dividend_rate: 0, inflation: 0.03, ret: 0.07,
      income_tax: 0.30, local_tax: 0.01, cap_gains_tax: 0.15,
      coast_multiple: 4, fi_multiple: 25, ...assum } });
  it("class cash rate compounds and is taxed as ordinary income", () => {
    const rows = run(probe([{ name: "c", tax: "cash", balance: 10_000 }],
                           { class_returns: { cash: 0.03 } }));
    // year1: tax = 10000*0.03*0.31 = 93; balance grows to 10300
    expect(rows[0]!.taxes).toBeCloseTo(93, 6);
    expect(rows[0]!.net_worth).toBeCloseTo(10_300, 6);
  });
  it("legacy cash (growth:0, no new fields) stays untaxed and flat", () => {
    const rows = run(probe([{ name: "c", tax: "cash", balance: 10_000, growth: 0 }]));
    expect(rows[0]!.taxes).toBe(0);
    expect(rows[0]!.net_worth).toBe(10_000);
  });
  it("growth-carrying cash account is NEVER cash-taxed, even in a plan opted into class_returns.cash", () => {
    // Spec ruling: cashTaxGated keys off whether the account's APPLIED
    // rate comes from the new fields (acc.ret / class_returns.cash) —
    // `growth` keeps absolute precedence in the resolution chain, so its
    // presence means the applied rate is NOT from the new fields, full
    // stop, regardless of what the plan's class_returns says. This is the
    // exact case the final review flagged as wrongly taxed under the old
    // plan-level gate ($1,240 taxed on a $10,000 * 0.04 balance it should
    // never have touched).
    const rows = run(probe([{ name: "c", tax: "cash", balance: 10_000, growth: 0.04 }],
                           { class_returns: { cash: 0.03 } }));
    expect(rows[0]!.taxes).toBe(0);
    expect(rows[0]!.net_worth).toBeCloseTo(10_400, 6); // grows at growth (0.04), not class_returns.cash
  });
  it("taxable grows at FULL resolved rate; dividend slice taxed only", () => {
    const rows = run(probe([{ name: "b", tax: "taxable", balance: 10_000, basis: 10_000, ret: 0.05 }],
                           { dividend_rate: 0.02 }));
    expect(rows[0]!.net_worth).toBeCloseTo(10_500, 6);           // full 5%
    expect(rows[0]!.taxes).toBeCloseTo(10_000 * 0.02 * 0.15, 6); // slice only
  });
});

describe("rates schedule dominates ret/class_returns (invested-ignored-in-MC rule)", () => {
  // Mirrors rates-schedule.test.ts's "an account with explicit growth
  // ignores the schedule's ret" — but for the *new* per-class-return
  // fields: unlike legacy `growth` (which always wins), `ret` and
  // `class_returns` are meant to be dominated by a rates schedule when
  // one is present, so sampled MC paths aren't short-circuited by a
  // per-account/class override.
  const shockSchedule = (a: { start_year: number; end_year: number; inflation: number }): YearRates[] => {
    const out: YearRates[] = [];
    for (let y = a.start_year; y <= a.end_year; y++) out.push({ year: y, ret: -0.5, inflation: a.inflation });
    return out;
  };
  it("account ret override still follows the schedule when one is present", () => {
    const plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "r", tax: "roth", balance: 1000, ret: 0.05 }],
      incomes: [], social_security: [], expenses: [], contributions: [],
      assumptions: { ...DEFAULT_ASSUMPTIONS },
    });
    const rows = run(plan, undefined, shockSchedule(plan.assumptions));
    // schedule dominates acc.ret: collapses at -50%/yr, not +5%/yr
    expect(rows[0]!.net_worth).toBeCloseTo(500, 6);
  });
  it("class_returns rate still follows the schedule when one is present", () => {
    const plan = normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "b", tax: "taxable", balance: 1000, basis: 1000 }],
      incomes: [], social_security: [], expenses: [], contributions: [],
      assumptions: { ...DEFAULT_ASSUMPTIONS, dividend_rate: 0, class_returns: { taxable: 0.05 } },
    });
    const rows = run(plan, undefined, shockSchedule(plan.assumptions));
    // schedule dominates class_returns.taxable: collapses, not +5%/yr
    expect(rows[0]!.net_worth).toBeCloseTo(500, 6);
  });
});
