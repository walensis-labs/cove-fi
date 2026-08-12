import { describe, expect, it } from "vitest";
import { run } from "../../src/engine.js";
import { planFromJson } from "../../src/planjson.js";

const probe = (over: object) =>
  planFromJson({
    birth_year: 1990,
    accounts: [],
    incomes: [],
    social_security: [],
    expenses: [],
    contributions: [],
    house: null,
    assumptions: {
      start_year: 2026,
      end_year: 2046,
      first_year_fraction: 1.0,
      retirement_year: 2099,
      dividend_rate: 0,
      inflation: 0.03,
      ret: 0.07,
      income_tax: 0.3,
      local_tax: 0.01,
      cap_gains_tax: 0.15,
      coast_multiple: 4.0,
      fi_multiple: 25.0,
    },
    ...over,
  });

describe("closed-form validation", () => {
  it("compound growth: B_n = B_0 (1+r)^n", () => {
    const p = probe({ accounts: [{ name: "b", tax: "roth", balance: 10_000 }] });
    const rows = run(p);
    // growth applies within year 1, so year k row = B0 * (1+r)^(k+1)
    expect(rows[20]!.net_worth).toBeCloseTo(10_000 * 1.07 ** 21, 4);
  });
  it("mortgage amortization matches the annuity formula", () => {
    // n = -ln(1 - B*i/P) / ln(1+i), monthly i = r/12
    const B = 300_000;
    const r = 0.06;
    const P = 2_500;
    const i = r / 12;
    const n = Math.ceil(-Math.log(1 - (B * i) / P) / Math.log(1 + i)); // months
    const payoffYearIndex = Math.ceil(n / 12) - 1; // 0-based row
    const p = probe({
      accounts: [{ name: "cash", tax: "cash", balance: 10_000_000, growth: 0 }],
      house: { value: 500_000, appreciation: 0, mortgage: { balance: B, rate: r, payment_monthly: P } },
    });
    const rows = run(p);
    // expenses include P&I while the loan lives; after payoff month they stop.
    // The payoff year's housing expense < 12*P; the year after is ~0 P&I.
    const yearlyPI = rows.map((rw) => rw.expenses);
    expect(yearlyPI[payoffYearIndex]!).toBeLessThan(12 * P);
    expect(yearlyPI[payoffYearIndex + 1] ?? 0).toBeCloseTo(0, 4);
    // first-year interest share: month 1 interest = B*i
    // total year-1 expense = 12 payments (all P&I here) = 12*P while far from payoff
    expect(yearlyPI[0]!).toBeCloseTo(12 * P, 4);
  });
  it("today's-$ indexing: income grows at exactly (1+inflation)", () => {
    const p = probe({
      incomes: [{ name: "s", amount: 50_000, start: 2026, end: 2046 }],
      accounts: [{ name: "cash", tax: "cash", balance: 0, growth: 0 }],
    });
    const rows = run(p);
    expect(rows[5]!.income / rows[4]!.income).toBeCloseTo(1.03, 10);
  });
});
