# Assumptions

> **Keep in sync:** this table is hand-written from
> `packages/cove-fi/src/defaults.ts`'s `CITED_DEFAULTS` array. If you change
> a default value or its citation there, update this table in the same
> commit (and vice versa) — nothing regenerates it automatically.

Every plan carries an `[assumptions]` table (`Assumptions` in
`src/model.ts`); values below are `DEFAULT_ASSUMPTIONS`, used whenever a
plan file omits a field. All are flat, single-number placeholders currently —
see [`docs/SEMANTICS.md`](./SEMANTICS.md) (tax model) for the seams
planned to replace them (e.g. a real progressive-bracket `FlatTax`
implementation).

| Key | Default | Unit | Source |
|---|---|---|---|
| `inflation` | 0.03 | annual rate | long-run US CPI ~2.9% 1926-2024; Fed target 2% + margin |
| `ret` | 0.07 | annual nominal rate | nominal; ~10% S&P long-run minus dilution/fees, conservative |
| `dividend_rate` | 0.015 | annual rate of taxable balances | S&P trailing yield 2024-2026 range |
| `income_tax` | 0.30 | flat effective rate | flat effective placeholder - FlatTax seam, see docs/SEMANTICS.md (tax model) |
| `local_tax` | 0.01 | flat effective rate | flat effective placeholder - FlatTax seam, see docs/SEMANTICS.md (tax model) |
| `cap_gains_tax` | 0.15 | flat effective rate | US LTCG middle bracket |
| `coast_multiple` | 4.0 | x trailing spend | deprecated 0.4: ignored — coast is now the true CoastFIRE expectations test (see fi_multiple, retirement_year) |
| `fi_multiple` | 25.0 | x annual spend | 4% rule, Trinity study (1/0.04 = 25) |

Not cited above (household-specific, no universal default to justify):
`start_year`, `end_year`, `first_year_fraction`, `retirement_year`.

## Spending smile (reserved, OFF currently)

`SPENDING_SMILE_FLAG` (`"spending_smile"`, `src/defaults.ts`) names a future
flag for a non-flat retirement spending curve: Blanchett, David M. (2014),
*"Estimating the True Cost of Retirement,"* which found real household
spending tends to decline through the "go-go"/"slow-go" retirement years
and rise again late in life with healthcare costs (the "spending smile").
The flag is reserved but **OFF by default** in this release — the engine
ignores it and projects flat real spending; see
[`docs/VALIDATION.md`](./VALIDATION.md) for why.
