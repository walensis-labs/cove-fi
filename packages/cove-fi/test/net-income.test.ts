import { describe, expect, it } from "vitest";
import { run } from "../src/engine.js";
import { planFromJson } from "../src/planjson.js";

const base = (over: object = {}) => planFromJson({
  birth_year: 1990,
  accounts: [{ name: "401k", tax: "trad", balance: 0 },
             { name: "cash", tax: "cash", balance: 0, growth: 0 }],
  incomes: [{ name: "salary", amount: 100_000, start: 2026, end: 2030, net: true }],
  social_security: [], expenses: [],
  contributions: [{ account: "401k", start: 2026, end: 2030, amount: 10_000, pretax: true }],
  house: null,
  assumptions: { start_year: 2026, end_year: 2027, first_year_fraction: 1.0,
    retirement_year: 2031, dividend_rate: 0, inflation: 0, ret: 0,
    income_tax: 0.30, local_tax: 0.01, cap_gains_tax: 0.15,
    coast_multiple: 4, fi_multiple: 25 },
  ...over });

describe("net income gross-up", () => {
  it("reports the closed-form gross and reconciles take-home to the stated net", () => {
    const r = run(base())[0]!;
    // gross = 100000/(1-0.31) + 10000 = 144927.5362... + 10000
    expect(r.income).toBeCloseTo(100_000 / 0.69 + 10_000, 4);
    // taxes = (gross - pretax) * 0.31
    expect(r.taxes).toBeCloseTo((100_000 / 0.69) * 0.31, 4);
    expect(r.contributions).toBeCloseTo(10_000, 6);
    // take-home identity: income - taxes - contributions === the stated net
    expect(r.income - r.taxes - r.contributions).toBeCloseTo(100_000, 4);
    // and with no explicit expenses, the whole take-home is surplus-spent
    expect(r.expenses).toBeCloseTo(100_000, 4);
  });

  it("a gross-declared income of the same take-home is NOT equal (proves the flag does work)", () => {
    const netRun = run(base())[0]!;
    const grossRun = run(base({ incomes: [
      { name: "salary", amount: 100_000, start: 2026, end: 2030 }] }))[0]!;
    expect(grossRun.income).toBeCloseTo(100_000, 6);
    expect(netRun.income).toBeGreaterThan(grossRun.income + 40_000);
  });

  it("match and pct_of_income bases use the grossed-up figure", () => {
    const p = base({ contributions: [
      { account: "401k", start: 2026, end: 2030, pct_of_income: 0.10 }] });
    // no pretax rung -> gross = 100000/0.69 = 144927.5362; 10% of that
    expect(run(p)[0]!.contributions).toBeCloseTo((100_000 / 0.69) * 0.10, 4);
  });

  it("mixed net + gross incomes: pretax attributes to the net line", () => {
    const p = base({ incomes: [
      { name: "salary", amount: 100_000, start: 2026, end: 2030, net: true },
      { name: "consulting", amount: 20_000, start: 2026, end: 2030 }] });
    const r = run(p)[0]!;
    // gross = 20000 + (100000/0.69 + 10000)
    expect(r.income).toBeCloseTo(20_000 + 100_000 / 0.69 + 10_000, 4);
  });

  it("no gross-up in retirement years (no ordinary tax is applied there)", () => {
    const p = base({
      incomes: [{ name: "pension", amount: 40_000, start: 2026, end: 2030, net: true }],
      contributions: [],
      assumptions: { ...base().assumptions, retirement_year: 2026, end_year: 2027 } });
    expect(run(p)[0]!.income).toBeCloseTo(40_000, 6);
  });

  it("rejects net + taxable:false", () => {
    expect(() => base({ incomes: [
      { name: "s", amount: 1000, start: 2026, end: 2030, net: true, taxable: false }] }))
      .toThrowError(/net/i);
  });

  it("throws when ordRate >= 1 and a net income is active", () => {
    expect(() => run(base({ assumptions: { ...base().assumptions,
      income_tax: 0.9, local_tax: 0.15 } })))
      .toThrowError(/gross up net income/);
  });

  it("conservation holds with net income (working-year identity)", () => {
    for (const r of run(base()).filter(x => x.year < 2031)) {
      const resid = r.income - r.taxes - r.contributions - r.expenses;
      expect(resid, `year ${r.year}`).toBeLessThan(1);
      expect(resid, `year ${r.year}`).toBeGreaterThan(-20_000);
    }
  });
});
