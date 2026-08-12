# @walensis/cove-fi

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
