# @walensis/cove-fi

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
