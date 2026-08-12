# Semantics

The engine's rules, in its own voice — what a plan file's fields actually
mean and how `run()` (`packages/cove-fi/src/engine.ts`) resolves them year
by year. For *why* a rule exists (citation, empirical grounding), see
[`docs/VALIDATION.md`](./VALIDATION.md) and
[`docs/ASSUMPTIONS.md`](./ASSUMPTIONS.md).

## The contribution waterfall

Each working year (`year <= retirement_year - 1`), contribution rungs
(`Plan.contributions`) fund **in priority order** — the order they appear
in the plan — for as long as available cash flow holds out:

```
available = gross_income - taxes - explicit_expenses
```

Each rung in turn claims `min(what it wants, available)`, `available`
drops by that amount, and the loop moves to the next rung. A rung that
wants more than what's left simply gets partially funded (or zero) — it
never triggers a withdrawal from any account to keep itself funded. This
is strictly **cash-flow constrained**, never withdrawal-funded, in both
directions: no rung, however high its priority, can pull from savings.

Pretax rungs (401(k), HSA — `pretax: true`) reduce the taxable income base
they're funded from, which changes the tax bill, which changes how much
cash is `available` for later rungs — so the waterfall is solved
iteratively (fixed-point over at most 4 passes) rather than in one shot.

**Surplus is spent.** Once every rung that wants funding has been offered
its share, any cash flow left over (`income - taxes - contributions -
expenses > 0`) is added straight into that year's `expenses` — there is no
"leftover goes to savings" behavior. This is the engine's one and only
cash-flow default.

**Working-year deficits are not funded.** If a one-time or lumpy expense
outruns available cash flow before the waterfall's rungs have clamped
themselves to zero, the year's cash-flow identity can run slightly
negative — the engine does not reach into an account to cover it. See
`docs/VALIDATION.md`'s Known Limitations for the bound this is held to in
tests.

## Nominal internals, today's-dollars at the edges

Every plan amount (income, expense, contribution `amount`) is specified in
**today's dollars** (the plan's `start_year`) unless the field says
otherwise. Internally the engine compounds a nominal growth factor `f`
forward year over year and applies it to convert today's-dollars inputs
into nominal-dollars-for-that-year before doing any arithmetic. Output
rows (`YearRow`) are nominal too — a downstream consumer wanting
constant-dollars figures divides back out by the same cumulative inflation
factor.

`Expense.nominal_at_start` (a.k.a. "grow$") flips this for a specific
expense line: instead of being stated in today's-dollars and inflated from
the plan's `start_year`, the amount is nominal at the item's own start
year and compounds from there (see below for the exact rule).

## `nominal_at_start` compounding

An expense with `nominal_at_start: true` is nominal **at its own start
year**, not at the plan's start year — its growth clock runs from
`expense.start`, continuously, whether or not the expense line has begun
paying out yet. Concretely: a `nominal_at_start` expense beginning in 2030
on a plan that starts in 2026 is *already* nominal-adjusted for 2026→2030
by the time its `start` year arrives — it does not "reset" to a fresh
today's-dollars baseline at 2030. A regular (non-`nominal_at_start`)
expense, by contrast, is always stated in the plan's `start_year`
today's-dollars and inflates from there regardless of when it begins.

## Income-relative bases

`Contribution.pct_of_income` and `employer_match_pct` are both relative to
the plan's **actual, current-year gross income** (`gross`, the sum of that
year's active `Income` entries) — not a fixed number picked at plan-write
time. An employer match declared as `employer_match_pct: 0.04` matches
1:1 up to 4% of that year's actual household gross; a `pct_of_income:
0.22` brokerage rung wants 22% of that year's actual gross, clamped to
whatever an `annual_limit_key` limit allows and whatever cash flow is
actually `available`. Raising or lowering a plan's income amount changes
what these rungs and matches are worth without needing to edit the rungs
themselves.

## Tax model

`income_tax`, `local_tax`, and `cap_gains_tax` are flat effective rates —
placeholders for a future progressive-bracket `FlatTax` implementation
(the "`FlatTax` seam"). Ordinary tax (`income_tax + local_tax`) applies to
taxable gross income net of pretax contributions; capital-gains tax
applies to dividends and to the gain portion of taxable-account
withdrawals; Social Security benefits are taxed on their
`taxable_fraction` (default 0.85) once claimed and once working years have
ended.

## Retirement drawdown order

Once a year is past `retirement_year - 1` (the last working year), the
engine funds the gap between expenses+taxes and income by drawing down
accounts in a fixed order:

```
taxable → hsa → trad → roth → cash
```

Within `taxable`, only the gain fraction of each withdrawal
(`1 - basis/balance`) is taxed at `cap_gains_tax`, and basis is drawn down
proportionally alongside the balance. `trad` withdrawals are fully taxed
at the ordinary rate and gross-taxed iteratively (a withdrawal to cover
the tax on a withdrawal adds more tax, resolved by repeatedly folding the
extra tax back into `remaining` need until it clears). `roth` and `cash`
withdrawals are untaxed.

## RMDs

Once an account owner's age reaches 73, any account flagged `rmd: true`
is subject to a Required Minimum Distribution computed against the IRS
Uniform Lifetime Table (`RMD_TABLE`, keyed by age, capped at the age-100
divisor for any older age): `rmd = total_rmd_balance / divisor`. Ordinary
drawdown withdrawals already taken from `rmd`-flagged accounts that year
count against this requirement; only the shortfall (`rmd - already
taken`) is forced. Forced RMD amounts beyond what's needed to cover
expenses are, like any other surplus, spent rather than reinvested.

## Sentinels

- **`COAST` (`-1`).** Valid on a `Contribution`'s `start` or `end`. `end:
  -1` means "run until the plan's coast-fi trigger fires, then stop";
  `start: -1` means "dormant until coast triggers, then start." Coast
  triggers the first year `liquid_net_worth >= coast_multiple * (3-year
  trailing average expenses)` — once triggered, it's a one-time
  irreversible switch for the rest of the run.
- **`RETIREMENT` (`-2`).** Valid only on `Income.end`. Means "track this
  scenario's `retirement_year`" instead of a fixed year — resolved once,
  under *effective* assumptions (i.e. after any scenario override merges),
  to `retirement_year - 1`. A `--retirement-year` scenario override moves
  this income's end date automatically; the rest of `run()` never sees the
  sentinel.

## Reserved fields (accepted, not yet wired)

- **`Income.reduces_by_pretax`.** Accepted by the schema and defaulted
  (`false`) by `normalizePlan()`, but the engine does not currently read
  it — no income stream is reduced by pretax contributions based on this
  flag. Pretax rungs already reduce the *tax base* directly (see Tax
  model above); this field is reserved for a future per-income-stream
  reduction behavior distinct from that.
- **`Plan.drawdown_order`.** Accepted by the schema and defaulted to
  `DEFAULT_DRAWDOWN_ORDER` by `normalizePlan()`, but `run()` always uses
  its own fixed `["taxable", "hsa", "trad", "roth", "cash"]` order (see
  Retirement drawdown order above) regardless of what this field is set
  to. Setting it currently has no effect on engine output.
