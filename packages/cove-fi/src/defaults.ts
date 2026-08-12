/**
 * Cited defaults — the numeric assumptions this engine ships with, each
 * traced to a one-line justification. Consumed by `planfile.ts` (to annotate
 * `initTemplate()`'s TOML with a comment per assumption) and rendered by
 * hand into `docs/ASSUMPTIONS.md`; keep the two in sync (see that file's
 * header note).
 */

export interface CitedDefault {
  key: string;
  value: number;
  unit: string;
  source: string;
}

export const CITED_DEFAULTS: CitedDefault[] = [
  {
    key: "inflation",
    value: 0.03,
    unit: "annual rate",
    source: "long-run US CPI ~2.9% 1926-2024; Fed target 2% + margin",
  },
  {
    key: "ret",
    value: 0.07,
    unit: "annual nominal rate",
    source: "nominal; ~10% S&P long-run minus dilution/fees, conservative",
  },
  {
    key: "dividend_rate",
    value: 0.015,
    unit: "annual rate of taxable balances",
    source: "S&P trailing yield 2024-2026 range",
  },
  {
    key: "income_tax",
    value: 0.3,
    unit: "flat effective rate",
    source: "flat effective placeholder - FlatTax seam, see docs/SEMANTICS.md (tax model)",
  },
  {
    key: "local_tax",
    value: 0.01,
    unit: "flat effective rate",
    source: "flat effective placeholder - FlatTax seam, see docs/SEMANTICS.md (tax model)",
  },
  {
    key: "cap_gains_tax",
    value: 0.15,
    unit: "flat effective rate",
    source: "US LTCG middle bracket",
  },
  {
    key: "coast_multiple",
    value: 4.0,
    unit: "x trailing spend",
    source: "4% rule, Trinity study; coast = 4x trailing spend heuristic",
  },
  {
    key: "fi_multiple",
    value: 25.0,
    unit: "x annual spend",
    source: "4% rule, Trinity study (1/0.04 = 25)",
  },
];

/**
 * Reserved for a future retirement-spending curve (Blanchett 2014,
 * "Estimating the True Cost of Retirement" — the empirical "spending
 * smile": real spending declines through the go-go/slow-go years then
 * rises again with late-life healthcare costs). Off by default; see
 * docs/VALIDATION.md.
 */
export const SPENDING_SMILE_FLAG = "spending_smile" as const;
