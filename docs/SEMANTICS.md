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

### Named rungs and `hard_end`

As of 0.5.0, a `Contribution` may carry a `name` (unique among every OTHER
named rung — unnamed rungs never collide, and never being named is fine)
so `run_scenario`'s `overrides.contributions.keep` can target it by name,
and a `hard_end` — a plain calendar year that caps the rung independent of
its own `end`. `hard_end` never accepts the `COAST` (`-1`) or `RETIREMENT`
(`-2`) sentinels; `planjson` rejects them there with a named issue — those
sentinels are meaningful on `start`/`end`, not on a fixed cutoff. A rung is
inactive whenever `y > hard_end`, checked alongside the existing
`start`/`end`/COAST window logic in the same convergence loop — whichever
bound stops the rung first governs. This holds even for a COAST-`end` rung
(`end: -1`) whose trigger hasn't fired yet: an earlier `hard_end` stops it
regardless of COAST, and — having lost its contributions — a plan can wind
up never reaching its own coast trigger within the horizon at all. A
`hard_end` set later than everything else that could stop the rung never
binds; it's byte-identical to not having set it.

### Pretax-stop cash-flow rule (no engine change — falls out for free)

Deactivating a pretax rung (via `hard_end`, a `contributions.end` scenario
override — see Scenario overrides below — or the rung simply reaching its
own `end`) needs no special-case handling: it falls straight out of the
existing gross-income tax model. One fewer pretax dollar reducing the
taxable base means ordinary tax on that dollar now applies, so **taxes
rise by `amount x rate`** (`rate = income_tax + local_tax`); that same
dollar, no longer diverted into the rung, instead lands in that year's
spendable surplus via `cashFlowDefault: "spend"`, so **take-home
(`expenses`, since surplus is spent) rises by `amount x (1 - rate)`**. The
two together account for the whole stopped amount exactly: `amount x rate
+ amount x (1 - rate) = amount`. Pinned in
`test/contributions-overrides.test.ts`'s "pretax-stop" block with
hand-derived numbers (income 100k, a $10,000 pretax rung, `hard_end:
2027`, `income_tax + local_tax = 0.31`): the year after the rung stops,
taxes rise +$3,100 (`10,000 x 0.31`) and expenses (surplus) rise +$6,900
(`10,000 x 0.69`).

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

Cash interest is taxed only for cash accounts whose applied rate comes
from the new fields (`account.ret` or `class_returns.cash`); accounts
carrying the legacy `growth` field are never cash-taxed. `growth` keeps
absolute precedence in the resolution chain (Return model, step 1 above),
so its mere presence means the account's applied rate is NOT coming from
the new fields — full stop, regardless of what a plan-level
`class_returns.cash` says. This is a per-account, not per-plan, gate:

```
cashTaxGated(acc, a) = acc.tax === "cash"
  && acc.growth == null
  && (acc.ret != null || a.class_returns?.cash != null)
```

An untouched or `growth`-only cash account stays untaxed, exactly
matching 0.3.0 behavior — this is a strictly additive, opt-in change, and
it holds even for a `growth`-carrying cash account sitting inside a plan
that has otherwise opted into `class_returns.cash` for its other cash
accounts. When gated, the tax added each year is:

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

## Earmarked assets

As of 0.5.0, `Account.earmarked: true` marks a balance as saved toward a
specific goal (a house fund, an education fund held outside `tax: "529"`,
etc.) rather than general-purpose net worth. Setting it forces `liquid:
false` regardless of what `liquid` says (`normalizePlan`); an EXPLICIT
`liquid: true` alongside `earmarked: true` is a validation error at the
planjson boundary — "account X: earmarked accounts cannot be liquid".
Earmarked implies non-liquid everywhere, no exceptions.

**What's excluded.** An earmarked account's balance is pulled out of
`net_worth` and reported separately, every year, as
`YearRow.earmarked_net_worth` (mirrored at the FiStatus level as
`terminal_earmarked_net_worth`/`terminal_earmarked_net_worth_todays`).
Because `liquid_net_worth`, the true-CoastFIRE expectations test (FI and
Coast definitions below), and Monte Carlo's `success_rate` all key off
`acc.liquid`, an earmarked account is excluded from every one of them too
— FI year, coast year, depletion year, and MC success rate all skip it.
The discretionary retirement drawdown waterfall (`taxable -> hsa -> trad
-> roth -> cash`) skips it as well, via an explicit `if (acc.earmarked)
continue;` guard in the drawdown loop — it is never automatically raided
to cover a cash-flow gap. Inflating an earmarked balance 100x moves
nothing but `earmarked_net_worth` — pinned as an exclusion test in
`test/earmarked.test.ts`.

A legacy `liquid: false` account WITHOUT `earmarked` (e.g. a `tax: "529"`
account predating 0.5.0) is unaffected by any of this — it stays inside
`net_worth` exactly as before, in the same `il529` bucket the engine has
always kept separate from `liquid`.

**`fund_from` is the drawdown mechanism.** Being excluded from the
discretionary waterfall doesn't mean an earmarked account's money is
unreachable — an `Expense` with `fund_from` set to the account's name
draws directly from it (`take = min(bal[fund_from], amt)`), independent of
`retirement_year` or working-year status, exactly like the existing
529-funded-education path this reuses. This is the intended way to
actually spend earmarked money: attach the goal's expense to the account
via `fund_from` rather than relying on the general drawdown to find it —
it deliberately won't.

**Pathological note: earmarked + `rmd`.** RMDs are legally forced and are
NOT gated by `earmarked` — an account flagged both `rmd: true` and
`earmarked: true` still has its Required Minimum Distribution taken every
year once its owner turns 73 (see RMDs above), same as any other `rmd`
account. This is a genuinely pathological combination — an account
earmarked for one purpose, drained by law regardless of that purpose —
and the fix is to avoid it: don't flag `rmd` accounts as `earmarked`.

**Open product call: dividends are still taxed.** The dividend-tax
computation (dividends on `tax: "taxable"` balances, qualified, taxed at
`cap_gains_tax`) sums every taxable account's balance regardless of
`earmarked` — an earmarked TAXABLE account's dividends are still taxed to
the household every year, exactly like an ordinary taxable account. This
is current, deliberate behavior (the household still legally owns the
account, whatever the money is earmarked for) but it's a live product
question, not a fully settled one, and may be revisited in a future
release.

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

## Scenario overrides

`run_scenario` (MCP), the CLI's `scenario` command, and `compare` all turn
a base `Plan` into a modified one through one code path — `applyOverrides`
(`session.ts`) — that is pure (never mutates its input `Plan` or the
override object) and, for the `contributions` override specifically,
atomic: a thrown validation error leaves the session's current plan
untouched.

**Strict validation (0.5.0 bug fix).** The MCP boundary is `.strict()`: an
unrecognized top-level key, or an unrecognized key nested inside
`contributions`, is a validation ERROR naming the offending key(s) and the
full supported set (`SCENARIO_OVERRIDE_KEYS`, `mcp/server.ts`) — not a
silent no-op. **Before 0.5.0, an unknown key was silently stripped** by a
permissive `z.object`, and the scenario ran to completion as an
unmodified copy of the base plan with no error — a typo'd override key
(e.g. `contributions_end` instead of `contributions.end`) looked like it
worked. Re-run any scenario you were trusting before this release.

The supported top-level keys are:

- **`retirement_year`** (number) — overwrites `assumptions.retirement_year`.
  Any `Income` whose `end` is the `RETIREMENT` sentinel follows it for
  free (see Sentinels above).
- **`inflation`** (number) — overwrites `assumptions.inflation`. Ignored
  under Monte Carlo (see Monte Carlo below).
- **`ret`** (number) — overwrites `assumptions.ret`, the global-default
  rung of the Return model's precedence chain. Ignored under Monte Carlo
  and, deterministically, for any account whose own `growth`/`ret` or
  whose tax class's `class_returns` entry outranks the global default.
- **`class_returns`** (per-tax-class map) — REPLACES
  `assumptions.class_returns` wholesale, not a per-key merge. Deterministic
  runs only — Monte Carlo's rates schedule dominates `ret`/`class_returns`
  for every account, cash included.
- **`savings_rate_multiplier`** (number) — a blanket knob that predates
  `contributions`: scales EVERY rung's `amount`/`pct_of_income` by the
  multiplier (a `to_limit` rung converts to a fixed `amount =
  IRS_LIMITS_2026[key] x multiplier`, dropping `to_limit`), no exceptions
  — it is not scoped by `contributions.keep` (see below).
- **`contributions`** (`{ end?, keep?, scale? }`, 0.5.0) — per-rung
  overrides; see its own subsection immediately below.
- **`ss_haircut`** / **`ss_claim_year`** (number) — overwrite the matching
  field on EVERY `SocialSecurity` entry in the plan.
- **`extra_expenses`** / **`extra_incomes`** (arrays) — APPEND to the
  plan's existing `expenses`/`incomes` lists; they do not replace anything.

### `contributions` {end, keep, scale}

Applies AFTER `savings_rate_multiplier` inside `applyOverrides` — the two
COMPOSE, a rung can be touched by both in sequence (multiplier first,
`contributions.scale` second: e.g. multiplier `0.5` then scale `0.5`
leaves a non-kept rung's amount at 0.25x). Resolution order:

1. **`keep`** (an array of rung names) resolves first. Every name must
   match a currently-named rung or the call throws, listing the unknown
   names — unnamed rungs can never be kept. Kept rungs are excluded
   byte-for-byte from THIS override's own `scale`/`end` — but
   `savings_rate_multiplier` still touches them, since it's a blanket
   knob that predates `keep`. This is a deliberate scoping ruling on a
   spec-silent fork, not an oversight: **`keep` exempts a rung from
   `contributions.scale`/`.end` only.**
2. **`scale`** (a finite number `>= 0`) multiplies every non-kept rung's
   `amount`/`pct_of_income`, converting a `to_limit` rung to a fixed
   amount the same way `savings_rate_multiplier` does above.
3. **`end`** (a finite integer year) tightens every non-kept rung's
   `hard_end` to `min(existing hard_end ?? Infinity, end)` — it can only
   pull a cutoff EARLIER, never push it later; the rung's own `end` (or
   COAST trigger) still governs if that lands earlier still. **End clamps
   never extend** — here or anywhere else `hard_end` is set.

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
