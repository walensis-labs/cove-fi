# @walensis/cove-fi

## 0.6.0

### Minor Changes

- b102f30: The net-income trap, plus three trust tools: a take-home -> gross
  calculator, an engine-version handshake, and a per-year cash-flow audit.

  **No plan's projected numbers change in this release.** `run()` and
  `YearRow` are untouched; every existing plan's projected numbers are
  byte-identical to before. Everything below is additive.

  1. **The trap: if you seeded income from take-home deposits, your plan has
     been taxing already-taxed money.** Cove FI plans have always stored
     GROSS (pre-tax) income — there is no `Income.net` field, and the engine
     does no gross-up on your behalf. A plan built from a YNAB export, a
     paycheck deposit, or any other post-tax figure understates gross income,
     which understates every income-relative contribution/match base (`Contribution.pct_of_income`,
     `employer_match_pct`) alongside the ordinary tax bill computed against
     it — a self-consistent but wrong picture. **If this might be you, run
     the new `income_gross_from_net` calculator with your real numbers and
     replace the income figure in your plan with the computed gross.**

  2. **NEW: `income_gross_from_net { net_annual, deferrals_annual?, income_tax?, local_tax?, stated_gross? }`**
     — a propose-only calculator (never touches the loaded plan) computing
     `gross = net_annual / (1 - (income_tax + local_tax)) + deferrals_annual`.
     Rates default to the loaded plan's assumptions when omitted; passing
     `stated_gross` reconciles a self-reported figure against the computed
     one (`reconciliation.agrees` when within 1%). The `onboard` prompt now
     calls this automatically: it settles gross-vs-take-home per income
     stream, annualizes period figures, collects every pretax deferral, and
     reads the full chain back for confirmation before any number reaches
     `create_plan`/`update_plan`.

  3. **NEW: `get_engine_info`** — a handshake tool (callable before any plan
     is loaded) reporting the server's `version`, `metrics_version`, the live
     `run_scenario` override key list, `metric_definitions`, and every
     registered tool name (`capabilities`, derived — not hand-maintained —
     from actual tool registration). Detect a stale or partial deploy before
     trusting any other tool's numbers, and re-check `metrics_version`
     whenever a cached metric (e.g. `coast_year`) needs revalidating against
     its current definition. `fi_status`/`run_projection` now carry
     `metrics_version` alongside their numbers too.

  4. **NEW: opt-in engine `detail` + `audit_cash_flow { scenario?, from_year?, to_year? }`**
     — `runWithMeta(..., { detail: true })` can now return a per-year
     breakdown (incomes/expenses/contributions/withdrawals/a 4-bucket tax
     split) that reconciles EXACTLY to each `YearRow`'s totals; strictly
     opt-in, so rows are byte-identical whether or not it's requested. The
     new `audit_cash_flow` MCP tool turns this into a per-year table
     (income/taxes/expenses/contributions/surplus) with two flag classes:
     duplicate income/expense line names within a year, and `fund_from`
     expenses whose account fell short of covering the full amount. A clean
     plan returns an empty `flags` array for every year.

  See `docs/SEMANTICS.md` (Income is always gross, Metric versioning,
  Cash-flow audit) for the full rules.

## 0.5.0

### Minor Changes

- 94e2b5a: Strict scenario-override validation (bug fix), named contribution rungs
  with per-rung stop/scale/keep scenario overrides, and first-class
  earmarked assets.

  **Behavior changes — read before upgrading:**

  1. **BUG FIX: unknown scenario override keys used to be silently
     ignored — they now error.** `run_scenario` (MCP), and any nested
     `extra_expenses`/`extra_incomes`/`contributions` object inside it, is
     now `.strict()`: a typo'd or unsupported key (e.g. `contributions_end`
     instead of `overrides.contributions.end`) throws an error naming the
     offending key(s) and the full supported set, instead of being silently
     stripped and the scenario running to completion as an unmodified copy
     of the base plan. **If you built a scenario before this release and
     trusted its output, re-run it** — if it had a typo'd or unsupported
     key, its result was silently identical to the base plan the whole
     time, not whatever you thought you were modeling.
  2. **`net_worth` now excludes accounts flagged `earmarked: true`.** A new
     `Account.earmarked` flag (opt-in, off by default — nothing changes for
     existing plans) marks a balance as saved toward a specific goal rather
     than general-purpose net worth. Earmarked balances are pulled out of
     `net_worth`/`liquid_net_worth`, FI year, coast year, depletion year,
     Monte Carlo success rate, and the retirement discretionary drawdown
     waterfall — reported separately instead, every year, as the new
     `earmarked_net_worth` field (`terminal_earmarked_net_worth`/`_todays`
     in `fi_status`). Setting `earmarked: true` forces `liquid: false`
     regardless of what `liquid` says; an explicit `liquid: true` alongside
     `earmarked: true` is now a validation error. Spend earmarked money via
     an expense's `fund_from`, the same mechanism 529-funded education
     already used — the discretionary drawdown deliberately can't find it
     on its own. One caveat, current and deliberate but not fully settled:
     dividends on an earmarked _taxable_ account are still taxed to the
     household every year (the household still legally owns the account).
  3. **NEW: named contribution rungs + stop/scale/keep scenario
     overrides.** A `Contribution` may now carry a `name` (unique among
     named rungs) and a `hard_end` (a plain calendar year that caps it
     independent of its own `end`). `run_scenario`'s new
     `overrides.contributions: { end?, keep?, scale? }` — and the CLI
     scenario command's matching `--contributions-end`/
     `--contributions-scale`/`--contributions-keep` flags — let you clamp,
     scale, or exempt individual named rungs, composing with (applied
     after) the existing blanket `savings_rate_multiplier`. `end` clamps
     never extend a rung past its own `end`/COAST trigger; `keep` exempts a
     rung from `contributions.scale`/`.end` only — `savings_rate_multiplier`
     still applies to kept rungs, since it's a blanket knob that predates
     `keep`.

  See `docs/SEMANTICS.md` (Named rungs and `hard_end`, Pretax-stop
  cash-flow rule, Scenario overrides, Earmarked assets) for the full rules.

## 0.4.0

### Minor Changes

- 0756e0f: Per-account and per-tax-class return overrides (`Account.ret`,
  `assumptions.class_returns`), sitting alongside the global `ret` default
  with a fixed precedence (account -> class -> global; the legacy `growth`
  field and, under Monte Carlo, the sampled rates schedule both still win
  outright — see `docs/SEMANTICS.md`'s Return model section), plus a true
  CoastFIRE redefinition of `coast_year`.

  **Behavior changes — read before upgrading:**

  1. **`coast_year` is redefined (true CoastFIRE).** It used to mean
     "current liquid balance >= `coast_multiple` x trailing spend"; it now
     means "every liquid account, grown from its current balance at its own
     resolved rate with no further contributions, would clear `fi_multiple
x` projected retirement-year spending by `retirement_year`." This
     shifts `coast_year` for **every plan**, and shifts COAST-sentinel
     (`start`/`end = -1`) contribution timing for any plan that uses it.
     `assumptions.coast_multiple` is now **ignored** (deprecated, still
     accepted for backward compatibility — setting it has no effect).
  2. **Opting a cash account into the new return model taxes its
     interest.** This is gated **per account**, on whether that account's
     applied rate actually comes from the new fields: if an individual cash
     account sets `ret`, or it falls back to a plan-level
     `assumptions.class_returns.cash` default, its resolved growth is now
     taxed as ordinary income every year (working and retired) — real
     interest-income treatment. A cash account carrying the legacy `growth`
     field is NEVER taxed, even inside a plan that has otherwise opted into
     `class_returns.cash` for its other cash accounts — `growth` keeps
     absolute precedence, so that account's applied rate isn't coming from
     the new fields at all. Untouched or `growth`-only cash accounts are
     unaffected and stay untaxed, matching 0.3.0 exactly; this is opt-in
     only. The tax is computed on the pre-withdrawal balance each year — a
     documented approximation (it mirrors the engine's existing
     dividend-tax computation, and can modestly overtax a cash account in a
     year it's also being drawn down toward depletion).
  3. **Monte Carlo cash sleeves now follow a historical T-bill path**
     (vendored 3-month T-bill series, Damodaran), sampled from the SAME
     historical year as that trial's equity/inflation path — instead of
     riding the equity path like every other account class. Expect
     materially narrower p10-p90 percentile bands for cash-heavy plans;
     equity-only plans are numerically unaffected (pinned).

  See `docs/SEMANTICS.md` (Return model, FI and Coast definitions) and
  `docs/ASSUMPTIONS.md` for the full rules and citations.

## 0.3.0

### Minor Changes

- c6e45b7: Conversational onboarding: a guided `onboard` MCP prompt that checks for
  existing plans, offers propose-only YNAB seeding, and walks a manual
  interview when needed — backed by plan discovery (`~/.cove-fi/plans`,
  overridable with `COVE_FI_PLANS`) and new `list_plans`/`create_plan`/
  `update_plan`/`save_plan` tools, plus bare-name resolution for `load_plan`.
  YNAB seeding rides on `@walensis/ynab-client` (`seed_from_ynab`, gated on
  `COVE_FI_YNAB_TOKEN`/`YNAB_TOKEN`) and never writes to the loaded plan
  itself — it only returns a proposal for the caller to confirm.

  Also:

  - `get_assumptions` now returns `{ assumptions, citations }` instead of a
    bare assumptions object — **breaking shape change** for existing
    consumers of that tool.
  - `income.end = "retirement"` is now accepted in the JSON/MCP plan path
    (`create_plan`/`update_plan`), not just TOML plan files.
  - `monte_carlo`'s `trials` is now validated as a positive integer instead
    of silently accepting `0` or fractional values.
  - Added an `engines` field to the package manifest.
  - CLI: `cove-fi plans` lists saved plans, and bare plan names (not just file
    paths) are now accepted by `run`/`scenario`/`compare`/`check`/`mc`.

## 0.2.1

### Patch Changes

- f6bcf57: Fix: the CLI and MCP server were silent no-ops when invoked through npm's bin
  symlink (npx, global installs, Claude Desktop/Cursor configs). The script-
  execution guard compared import.meta.url against the un-resolved argv[1]
  symlink path; both sides are now realpath'd. Direct `node dist/cli.js`
  invocations were unaffected, which is why tests and local smokes passed.

## 0.2.0

### Minor Changes

- 7f2cd1a: Monte Carlo simulation (seedable block bootstrap over 1928+ market history,
  benchmarked against the Trinity study / Bengen 4%-rule literature), and a
  research-grounded validation suite.

  Behavior changes vs 0.1.x — projection numbers shift:

  - pct-of-income rungs and employer matches now compute against your plan's
    actual gross income (previously a fixed internal base)
  - employer match = 1:1 up to pct × gross income
  - `coast_multiple` is now honored by coast detection
  - `income.end = "retirement"` (new sentinel) ends a stream at the effective
    retirement year, so `--retirement-year` scenarios move income with it
  - `Income.taxable = false` streams are now untaxed

## 0.1.0

### Minor Changes

- 8399c59: Initial release: deterministic FI/retirement projection engine, TOML plan files, CLI, stdio MCP server.
