# @walensis/cove-fi

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
