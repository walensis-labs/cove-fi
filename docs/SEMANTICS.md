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

Ordinary income tax on `Income` entries only applies in working years
(`year <= retirement_year - 1`) — a known simplification. An `Income` with
a fixed `end` past `retirement_year` (rather than `end = "retirement"`)
keeps contributing to `gross`/`income` in retirement years but is not
taxed there; only Social Security's `taxable_fraction` and drawdown
withdrawals are taxed post-retirement (see Retirement drawdown order
above).

## Return model

Every account's nominal growth rate for a given year resolves through a
fixed precedence chain, evaluated fresh each year (`growthRate` in
`engine.ts`):

1. **`Account.growth`** (legacy). If set — including `0` — it wins
   outright, for every account, every year, no exceptions. Nothing below
   is even consulted. This is the pre-0.4.0 knob and keeps absolute
   precedence for backward compatibility.
2. **A `rates` schedule, if one is active** (Monte Carlo, or a hand-built
   schedule passed to `run()`/`runWithMeta()` directly). Sampled market
   paths dominate over any per-account or per-class override — an
   account opted into `ret` or `class_returns` does not get to zero out
   its own trial variance. Non-cash-class accounts follow the schedule's
   `ret` (equity path); cash-class accounts (`tax === "cash"`) follow the
   schedule's `cash_ret` (a T-bill path — see Monte Carlo return
   partitioning below), falling back to `ret` when the schedule predates
   `cash_ret` (any hand-built or pre-0.4.0 schedule).
3. **`Account.ret`** (new-style override). Participates only when no
   schedule is active. Wins over the class/global default.
4. **`Assumptions.class_returns[acc.tax]`** (per-tax-class default). Wins
   over the global default when set and no account-level `ret` is set.
5. **`Assumptions.ret`** (global default). The fallback of last resort.

`resolveRet(acc, a)` (`model.ts`) implements steps 3-5 only (account ->
class -> global); `engine.ts`'s per-year `growthRate` wraps it with steps
1-2 (`growth`, then schedule dominance) on top. The **coast expectations
test** (see FI and Coast definitions below) always uses `acc.growth ??
resolveRet(acc, a)` directly — steps 1, 3, 4, 5 only, deliberately
skipping step 2 even when a schedule is driving the rest of the run,
because the coast projection is a plan-level expectation, not a sampled
trial outcome.

### Cash-interest taxation (gated)

A cash-class account's resolved growth rate is taxed as ordinary income —
every year, working or retired — only when the household has explicitly
opted into the new return model for that account:

```
cashTaxGated(acc, a) = acc.tax === "cash"
  && (acc.ret != null || a.class_returns?.cash != null)
```

An untouched or `growth`-only cash account stays untaxed, exactly
matching 0.3.0 behavior — this is a strictly additive, opt-in change.
When gated, the tax added each year is:

```
taxes += bal[acc] * growthRate[acc] * frac * (income_tax + local_tax)
```

computed on that account's balance **before** that year's retirement
drawdown withdrawals reduce it, using the same resolved rate the growth
step applies at year-end. This is a documented approximation, not a bug:
it mirrors the engine's existing dividend-tax computation (also levied on
the pre-drawdown taxable balance), and can modestly overtax a cash
account in a year it's also being drawn down toward depletion, since the
balance the tax is computed on is higher than the balance that actually
earns interest for the full year. No iterative correction is applied.

### Monte Carlo return partitioning

Under Monte Carlo (`runMonteCarlo`), each sampled historical year supplies
BOTH an equity return (`ret`, the vendored S&P 500 series) and a T-bill
return (`cash_ret`, the vendored 3-month T-bill series, Damodaran) drawn
from the SAME sampled index — so a trial's cash sleeve stays historically
correlated with that trial's equity/inflation path instead of being
sampled independently. Cash-class accounts follow `cash_ret`; every other
account class follows `ret`. Because T-bill returns are far less volatile
than equities, expect materially narrower p10-p90 percentile bands for
cash-heavy plans than for equity-heavy ones at the same starting balance.
`ret`/`inflation`/`class_returns` scenario overrides are ignored entirely
under Monte Carlo (see Monte Carlo below); `acc.ret`/`class_returns` are
likewise ignored per the schedule-dominance rule above.

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

## FI and Coast definitions

**FI year** (`fi_status`'s `fi_year`, `FiStatus` in `session.ts`): the
first projected year where that year's `liquid_net_worth >= fi_multiple x
that year's expenses` — a trailing-spend Trinity-study/4%-rule test
against the plan's actual projected path. `fi_multiple` defaults to 25
(1/0.04). Unaffected by the 0.4.0 coast change below.

**Coast year** (`coast_year`, on both `RunResult` and `FiStatus`), as of
0.4.0, is the true-CoastFIRE **expectations test** — not a trailing-spend
comparison. It asks, in each working year `y < retirement_year`: if every
liquid account grew from its CURRENT balance at its own resolved rate,
untouched, with no further contributions, would it be enough by
`retirement_year`? Concretely, the first `y` where

```
sum over liquid accounts of ( bal[acc] * (1 + coastGrowthRate[acc]) ** (retirement_year - y) )
  - mortgageBalanceAt(retirement_year)
  >= coastTargetAtRetirement
```

triggers coast — a one-time, irreversible switch for the rest of the run
(see the `COAST` sentinel below for what that switch does to contribution
rungs).

- **`coastGrowthRate[acc]`** is `acc.growth ?? resolveRet(acc, a)` (Return
  model above, steps 1/3/4/5) — always deterministic, computed once per
  account before the year loop, and NEVER reads an active `rates`
  schedule even when one is driving the rest of the run: the coast
  projection RATE reflects the plan's own expected returns, not that
  trial's sampled path. The CURRENT balance the test projects forward
  from, though, IS the plan's realized balance at year `y` — under an
  active rates schedule that balance is trial-dependent (it's whatever
  that trial's sampled path has produced by year `y`), so `coast_year`
  itself can still vary across Monte Carlo trials even though the
  forward-projection rate and the target never do.
- **`mortgageBalanceAt(retirement_year)`** is a pure amortization replay
  of the plan's mortgage (if any) from `start_year` through
  `retirement_year` at the mortgage's own fixed rate — netted out of the
  projected liquid balances because a mortgage balance still owed at
  retirement is a real claim against them.
- **`coastTargetAtRetirement`** (`engine.ts`) is `fi_multiple x` that
  year's projected retirement spending: every explicit expense active at
  `retirement_year`, grown by its own convention (today's-$ items by
  `(1 + inflation + growth_over_inflation) ** (retirement_year -
  start_year)`; `nominal_at_start` items by the same rate to the
  `retirement_year - e.start` power), plus house costs at
  `retirement_year` (appreciated property tax/insurance/maintenance, HOA,
  and that year's mortgage P&I) — all computed from CONSTANT rates
  (`a.inflation`, house appreciation), never a sampled schedule, since
  this is an expectation, not a trial outcome.
- **`fund_from` exclusion limitation.** Expenses with `fund_from` set
  (529-funded) are excluded from the target entirely, mirroring the
  engine's own per-year `exp` whenever the 529 fully covers them. This
  closed form has no way to know in advance whether the 529 will still
  have funds at `retirement_year` — if it would instead be DEPLETED
  before then, the engine's real per-year loop pushes the shortfall into
  household cash flow (`exp`), but the target calculation still excludes
  the full `fund_from` amount regardless. This UNDERSTATES the coast
  target for a plan whose 529 runs dry before retirement — a documented,
  not fixed, limitation (see `test/coast.test.ts`'s "fund_from" block).
- **`coast_multiple` is deprecated and ignored** as of 0.4.0 — it is read
  nowhere in the engine. The old rule ("current liquid balance >=
  coast_multiple x trailing spend") is gone; only `fi_multiple` and
  `retirement_year` drive coast now. Plans that still set `coast_multiple`
  keep validating (the field is still accepted, for backward-compatible
  plan files) but the value has no effect.

## Sentinels

- **`COAST` (`-1`).** Valid on a `Contribution`'s `start` or `end`. `end:
  -1` means "run until the plan's coast-fi trigger fires, then stop";
  `start: -1` means "dormant until coast triggers, then start." See FI
  and Coast definitions above for exactly what triggers coast as of
  0.4.0 and how `coast_year` is computed; this sentinel only governs a
  contribution rung's own start/end relative to that trigger. Once
  triggered, coast is a one-time irreversible switch for the rest of the
  run.
- **`RETIREMENT` (`-2`).** Valid only on `Income.end`. Means "track this
  scenario's `retirement_year`" instead of a fixed year — resolved once,
  under *effective* assumptions (i.e. after any scenario override merges),
  to `retirement_year - 1`. A `--retirement-year` scenario override moves
  this income's end date automatically; the rest of `run()` never sees the
  sentinel.

## Monte Carlo

`ret`/`inflation` scenario overrides are ignored under Monte Carlo (`Session.monteCarlo`, the `mc` CLI command, and the `monte_carlo` MCP tool) — per-year rates come from the sampled block-bootstrap market history instead; `retirement_year`, savings, social-security, and extra income/expense overrides all still apply.

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
