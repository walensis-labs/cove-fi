import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/engine.js";
import { RETIREMENT } from "../src/model.js";
import { planFromJson } from "../src/planjson.js";
import { dumpPlan } from "../src/planfile.js";
import { Session } from "../src/session.js";
import { syntheticPlan } from "./helpers/synthetic.js";

const base = (over: object = {}) => planFromJson({
  birth_year: 1990,
  accounts: [{ name: "401k", tax: "trad", balance: 0, rmd: true },
             { name: "cash", tax: "cash", balance: 0, growth: 0 }],
  incomes: [{ name: "salary", amount: 100_000, start: 2026, end: 2027 }],
  social_security: [], expenses: [], contributions: [],
  house: null,
  assumptions: { start_year: 2026, end_year: 2027, first_year_fraction: 1.0,
                 retirement_year: 2028, dividend_rate: 0, inflation: 0.03,
                 ret: 0, income_tax: 0.30, local_tax: 0.01, cap_gains_tax: 0.15,
                 coast_multiple: 4.0, fi_multiple: 25.0 },
  ...over,
});

describe("income-relative bases", () => {
  it("pct_of_income contributes pct × actual gross", () => {
    const p = base({ contributions: [{ account: "401k", start: 2026, end: 2027, pct_of_income: 0.10 }] });
    const rows = run(p);
    expect(rows[0]!.contributions).toBeCloseTo(10_000, 6);          // 10% of 100k
    expect(rows[1]!.contributions).toBeCloseTo(10_000 * 1.03, 6);   // indexed with income
  });
  it("employer match = min(contribution, pct × gross)", () => {
    const p = base({ contributions: [
      { account: "401k", start: 2026, end: 2027, amount: 3_000, employer_match_pct: 0.05 }] });
    const rows = run(p);
    // match capped by the 3k contribution (5% of 100k = 5k > 3k)
    // balance after year 1 = contrib + match (ret=0): 3000 + 3000
    expect(rows[0]!.contributions).toBeCloseTo(3_000, 6);
    // verify via net-worth: 401k got 6000; cash got surplus? surplus is spent -> NW = 6000
    expect(rows[0]!.net_worth).toBeCloseTo(6_000, 4);
  });
  it("match is pct × gross when contribution exceeds it", () => {
    const p = base({ contributions: [
      { account: "401k", start: 2026, end: 2027, amount: 20_000, employer_match_pct: 0.05 }] });
    expect(run(p)[0]!.net_worth).toBeCloseTo(25_000, 4); // 20k + 5k match
  });
  it("taxable:false income is untaxed but still spendable", () => {
    const taxed = base();
    const untaxed = base({ incomes: [{ name: "gift", amount: 100_000, start: 2026, end: 2027, taxable: false }] });
    const dTax = run(taxed)[0]!.taxes - run(untaxed)[0]!.taxes;
    expect(run(untaxed)[0]!.taxes).toBeCloseTo(0, 6);
    expect(dTax).toBeCloseTo(100_000 * 0.31, 6);
  });
});

describe("RETIREMENT sentinel + coast_multiple", () => {
  it("income.end = RETIREMENT follows scenario retirement_year", () => {
    const p = base({
      incomes: [{ name: "salary", amount: 100_000, start: 2026, end: RETIREMENT }],
      assumptions: { ...base().assumptions, end_year: 2032, retirement_year: 2030 },
    });
    const early = run(p, { retirement_year: 2028 });
    const late = run(p);
    const y2029 = (rows: ReturnType<typeof run>) => rows.find((r) => r.year === 2029)!;
    expect(y2029(early).income).toBe(0); // retired 2028 -> no salary 2029
    expect(y2029(late).income).toBeGreaterThan(0);
  });
});

describe("coast_multiple", () => {
  const coastYearAt = (cm: number) => {
    const p = { ...syntheticPlan(), assumptions: { ...syntheticPlan().assumptions, coast_multiple: cm } };
    const path = join(mkdtempSync(join(tmpdir(), "covefi-")), "p.toml");
    writeFileSync(path, dumpPlan(p));
    const s = new Session();
    s.loadPlanFile(path);
    return s.fiStatus().coast_year;
  };
  it("lower multiple coasts no later than higher", () => {
    const c3 = coastYearAt(3);
    const c6 = coastYearAt(6);
    expect(c3).not.toBeNull();
    expect(c6).not.toBeNull();
    expect(c3!).toBeLessThanOrEqual(c6!);
    expect(c3).not.toBe(coastYearAt(400) ?? -1); // absurd multiple never coasts (null) — proves the knob is live
  });
});
