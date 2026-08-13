/**
 * Cove FI engine — internal plan model.
 *
 * This is OUR schema. Third-party plan formats are one adapter away
 * (a future integrations layer, see the 0.3 roadmap); YNAB-derived plans
 * are another. All amounts are annual, in today's dollars unless noted.
 *
 * See docs/SEMANTICS.md for the engine's rules in full.
 */

export type TaxType = "cash" | "taxable" | "trad" | "roth" | "hsa" | "529";

export interface Account {
  name: string;
  tax: TaxType;
  balance: number;
  // Legacy per-account rate override. When set (including 0), it wins over
  // EVERYTHING else for growth — resolveRet() and class_returns never get a
  // say. null/undefined -> fall through to `ret` / resolveRet().
  growth?: number | null;
  liquid?: boolean;
  penalty_age?: number; // early-withdrawal age
  penalty_rate?: number;
  rmd?: boolean;
  basis?: number | null; // taxable accounts: starting cost basis
  // New-style override: participates in resolveRet() precedence (account ->
  // class_returns -> plan default) AND, for cash accounts, gates ordinary-
  // income taxation of the resolved growth rate (see cashTaxGated() in
  // engine.ts). Ignored for growth whenever `growth` above is set.
  ret?: number | null;
}

/** Per-tax-class default nominal return overrides (assumptions.class_returns). */
export type ClassReturns = Partial<Record<TaxType, number>>;

export interface Income {
  name: string;
  amount: number; // today's $/yr
  start: number;
  end: number; // inclusive last year
  taxable?: boolean;
  reduces_by_pretax?: boolean; // 401k/HSA deducted from this stream
}

export interface SocialSecurity {
  pia_monthly: number; // today's $
  claim_year: number;
  haircut?: number; // 1.0 = full, 0.5 = assume 50%
  taxable_fraction?: number;
}

export interface Expense {
  name: string;
  amount: number; // $/yr in today's $ unless nominal_at_start
  start: number;
  end: number;
  growth_over_inflation?: number; // e.g. healthcare +2 or +3
  nominal_at_start?: boolean; // amount is nominal at the item's own start year and compounds from there (see SEMANTICS.md)
  fund_from?: string | null; // account name (529-funded education)
}

export interface Mortgage {
  balance: number;
  rate: number; // annual, e.g. 0.02875
  payment_monthly: number; // P&I, nominal (fixed)
}

export interface House {
  value: number; // today's market value
  appreciation: number; // nominal, e.g. 0.039
  mortgage?: Mortgage | null;
  property_tax_rate?: number; // of market value
  insurance_rate?: number;
  maintenance_rate?: number;
  hoa_monthly?: number; // today's $
}

export interface Contribution {
  // One rung of the accumulation waterfall.
  account: string;
  start: number;
  end: number; // inclusive
  amount?: number | null; // today's $/yr, fixed
  pct_of_income?: number | null;
  annual_limit_key?: "401k" | "ira" | "hsa_family" | null;
  to_limit?: boolean; // contribute the IRS max
  employer_match_pct?: number | null; // % of salary
  employer_match_flat?: number | null; // today's $/yr
  pretax?: boolean; // reduces taxable income
}

export interface Assumptions {
  inflation: number;
  ret: number; // nominal investment return
  dividend_rate: number; // of taxable balances, qualified
  income_tax: number; // flat effective, ordinary
  local_tax: number;
  cap_gains_tax: number;
  start_year: number;
  end_year: number;
  first_year_fraction: number; // partial first year (start mid-year)
  retirement_year: number;
  coast_multiple: number; // x spending, 3yr avg LNW
  fi_multiple: number;
  class_returns?: ClassReturns; // per-tax-class nominal return defaults; see resolveRet()
}

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  inflation: 0.03,
  ret: 0.07,
  dividend_rate: 0.015,
  income_tax: 0.3,
  local_tax: 0.01,
  cap_gains_tax: 0.15,
  start_year: 2026,
  end_year: 2091,
  first_year_fraction: 1.0,
  retirement_year: 2052,
  coast_multiple: 4.0,
  fi_multiple: 25.0,
};

// IRS limits for 2026 (indexed at inflation thereafter — approximation)
export const IRS_LIMITS_2026: Record<"401k" | "ira" | "hsa_family", number> = {
  "401k": 24500.0,
  ira: 7500.0,
  hsa_family: 8750.0,
};

// Uniform Lifetime Table (abbreviated), age -> divisor
export const RMD_TABLE: Record<number, number> = {
  73: 26.5,
  74: 25.5,
  75: 24.6,
  76: 23.7,
  77: 22.9,
  78: 22.0,
  79: 21.1,
  80: 20.2,
  81: 19.4,
  82: 18.5,
  83: 17.7,
  84: 16.8,
  85: 16.0,
  86: 15.2,
  87: 14.4,
  88: 13.7,
  89: 12.9,
  90: 12.2,
  91: 11.5,
  92: 10.8,
  93: 10.1,
  94: 9.5,
  95: 8.9,
  96: 8.4,
  97: 7.8,
  98: 7.3,
  99: 6.8,
  100: 6.4,
};

export const DEFAULT_DRAWDOWN_ORDER = [
  "cash-excess",
  "529",
  "taxable",
  "hsa",
  "trad",
  "roth",
  "cash-all",
];

export interface Plan {
  birth_year: number;
  accounts: Account[];
  incomes: Income[];
  social_security: SocialSecurity[];
  expenses: Expense[];
  contributions: Contribution[];
  house?: House | null;
  assumptions: Assumptions;
  drawdown_order?: string[];
}

export const COAST = -1;

// Sentinel for Income.end: "follow the scenario's retirement_year" instead
// of a fixed year. Resolved by engine.run() to `retirement_year - 1` under
// EFFECTIVE assumptions (i.e. after scenario overrides merge), so a
// retirement-year what-if moves this income's end date automatically.
// Valid ONLY on Income.end — planFromJson rejects it anywhere else.
export const RETIREMENT = -2;

/**
 * Fill Python-dataclass defaults for every optional field, so JSON plans
 * that omit fields behave exactly like Python instances constructed with
 * their dataclass defaults. `run()` calls this first.
 */
export function normalizePlan(plan: Plan): Plan {
  return {
    ...plan,
    assumptions: { ...DEFAULT_ASSUMPTIONS, ...plan.assumptions },
    accounts: plan.accounts.map((acc) => ({
      ...acc,
      growth: acc.growth ?? null,
      liquid: acc.liquid ?? true,
      penalty_age: acc.penalty_age ?? 60,
      penalty_rate: acc.penalty_rate ?? 0.1,
      rmd: acc.rmd ?? false,
      basis: acc.basis ?? null,
    })),
    incomes: plan.incomes.map((i) => ({
      ...i,
      taxable: i.taxable ?? true,
      reduces_by_pretax: i.reduces_by_pretax ?? false,
    })),
    social_security: plan.social_security.map((ss) => ({
      ...ss,
      haircut: ss.haircut ?? 1.0,
      taxable_fraction: ss.taxable_fraction ?? 0.85,
    })),
    expenses: plan.expenses.map((e) => ({
      ...e,
      growth_over_inflation: e.growth_over_inflation ?? 0,
      nominal_at_start: e.nominal_at_start ?? false,
      fund_from: e.fund_from ?? null,
    })),
    contributions: plan.contributions.map((c) => ({
      ...c,
      amount: c.amount ?? null,
      pct_of_income: c.pct_of_income ?? null,
      annual_limit_key: c.annual_limit_key ?? null,
      to_limit: c.to_limit ?? false,
      employer_match_pct: c.employer_match_pct ?? null,
      employer_match_flat: c.employer_match_flat ?? null,
      pretax: c.pretax ?? false,
    })),
    house: plan.house
      ? {
          ...plan.house,
          mortgage: plan.house.mortgage ?? null,
          property_tax_rate: plan.house.property_tax_rate ?? 0,
          insurance_rate: plan.house.insurance_rate ?? 0,
          maintenance_rate: plan.house.maintenance_rate ?? 0,
          hoa_monthly: plan.house.hoa_monthly ?? 0,
        }
      : (plan.house ?? null),
    drawdown_order: plan.drawdown_order ?? [...DEFAULT_DRAWDOWN_ORDER],
  };
}

/**
 * Resolve the nominal return an account grows at, in precedence order:
 * an explicit per-account `ret` override, then the plan's per-tax-class
 * default (`class_returns`), then the plan's global default (`a.ret`).
 *
 * NOTE: this does not consider the legacy `growth` field — engine.ts's
 * growth loop applies `acc.growth ?? resolveRet(acc, a)`, since `growth`
 * keeps absolute precedence for backward compatibility.
 */
export function resolveRet(acc: Account, a: Assumptions): number {
  return acc.ret ?? a.class_returns?.[acc.tax] ?? a.ret;
}
