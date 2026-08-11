/**
 * Synthetic household for convention tests.
 *
 * Entirely invented numbers — nothing derived from or copied out of
 * `private/`. Exercises every branch the engine has: cash/taxable/trad
 * (RMD)/roth/hsa/529 accounts, a pretax-reducing income, Social Security
 * with a haircut, a growth-over-inflation expense, a nominal_at_start
 * expense, a 529-funded education expense, to_limit/pct_of_income/amount
 * contribution rungs with an employer match, and both COAST-start and
 * COAST-end rungs, plus a mortgaged house.
 */
import { COAST, DEFAULT_ASSUMPTIONS, normalizePlan, type Plan } from "../../src/model.js";

export function syntheticPlan(): Plan {
  const raw: Plan = {
    birth_year: 1990,
    accounts: [
      { name: "cash", tax: "cash", balance: 15000, growth: 0 },
      { name: "brokerage", tax: "taxable", balance: 40000, basis: 16000 }, // 40% basis
      { name: "401k", tax: "trad", balance: 120000, rmd: true },
      { name: "roth", tax: "roth", balance: 30000 },
      { name: "hsa", tax: "hsa", balance: 6000 },
      { name: "college529", tax: "529", balance: 12000, liquid: false },
    ],
    incomes: [{ name: "salary", amount: 100000, start: 2026, end: 2051, reduces_by_pretax: true }],
    social_security: [{ pia_monthly: 2000, claim_year: 2062, haircut: 0.75 }],
    expenses: [
      // base + healthcare + house sized to leave real cash-flow headroom
      // against $100k income under the default 31% flat tax rate — a
      // household with none left over never funds a pretax rung, which
      // would starve convention 5 (pretax reduces the tax base).
      { name: "base", amount: 40000, start: 2026, end: 2091 },
      { name: "healthcare", amount: 6000, start: 2026, end: 2091, growth_over_inflation: 0.02 },
      { name: "car", amount: 25000, start: 2035, end: 2035, nominal_at_start: true },
      { name: "college", amount: 15000, start: 2040, end: 2043, fund_from: "college529" },
    ],
    contributions: [
      {
        account: "401k",
        start: 2026,
        end: 2091,
        to_limit: true,
        annual_limit_key: "401k",
        pretax: true,
        employer_match_pct: 0.04,
      },
      { account: "hsa", start: 2026, end: 2091, to_limit: true, annual_limit_key: "hsa_family", pretax: true },
      { account: "roth", start: 2026, end: 2091, amount: 7000 },
      { account: "brokerage", start: 2026, end: 2091, pct_of_income: 0.1 },
      { account: "brokerage", start: COAST, end: 2091, amount: 3000 }, // COAST-start rung
      { account: "roth", start: 2026, end: COAST, amount: 1000 }, // COAST-end rung
    ],
    house: {
      value: 300000,
      appreciation: 0.039,
      mortgage: { balance: 220000, rate: 0.045, payment_monthly: 1100 },
      property_tax_rate: 0.009,
      insurance_rate: 0.003,
      maintenance_rate: 0.007,
      hoa_monthly: 30,
    },
    assumptions: { ...DEFAULT_ASSUMPTIONS, retirement_year: 2050, first_year_fraction: 0.5 },
  };
  return normalizePlan(raw);
}
