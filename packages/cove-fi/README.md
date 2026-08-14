# @walensis/cove-fi

Cove FI (`@walensis/cove-fi`) is a deterministic, annual retirement /
financial-independence projection engine. Give it a plan file (accounts,
income, expenses, contributions, Social Security, a house if you have one)
and it projects net worth, income, expenses, taxes, and withdrawals year by
year to see when you hit FI, when you could coast, and whether your money
outlives you.

Cove FI is the **Project** module of the Cove suite (Balance → Plan →
**Project**), but it's fully standalone — no other Cove tools required. It
ships as a CLI, a library, and an MCP server, so you can run it from a
terminal, script against it, or just talk to it from Claude Desktop, Claude
Code, or Cursor.

Cove for YNAB manages this month's money; Cove FI projects the next forty
years. Each works alone; together they talk.

The engine is grounded in research: its default assumptions aren't picked
for elegance, they're cited from published sources and IRS tables (see
[`docs/ASSUMPTIONS.md`](../../docs/ASSUMPTIONS.md)), and its behavior is
checked against closed-form math, cross-plan invariants, and a Monte Carlo
benchmark from the withdrawal-rate literature — see [Validation
status](#validation-status) below.

## Quickstart (under 5 minutes)

Install globally, or just run it with `npx` — no install needed:

```bash
npm install -g @walensis/cove-fi
# or, without installing: npx @walensis/cove-fi <command>
```

Scaffold a starter plan, edit a few lines to match your situation, and run
it:

```bash
cove-fi init my-plan.toml
```

Open `my-plan.toml` and edit at least these three lines — everything else
has a reasonable default:

- `[plan] birth_year` — your birth year
- `[[incomes]] amount` (the `salary` income) — your annual income
- `[assumptions] retirement_year` — the year you plan to retire

Then project it:

```bash
cove-fi run my-plan.toml
```

That prints a year-by-year table (net worth, liquid net worth, income,
expenses, taxes, contributions, withdrawals) plus your FI year, coast year,
and depletion year (if any). Try a scenario without touching the file:

```bash
cove-fi scenario my-plan.toml --retirement-year 2048
```

Set an income's `end = "retirement"` (the scaffolded `salary` income already
is) and it ends automatically the year before `retirement_year` — a
`--retirement-year` scenario override moves it too, no separate edit needed.

Other commands: `cove-fi check my-plan.toml` (validate without running),
`cove-fi compare my-plan.toml --scenario "base:" --scenario
"early:retirement_year=2048"` (side-by-side comparison table), and
`cove-fi run my-plan.toml --json` (machine-readable output, works on
`run`/`scenario`/`compare`).

See [`examples/`](../../examples) for three complete plans (conventional
retirement at 65, early retirement, and Coast FI) you can copy and adapt
instead of starting from the bare template.

## Use it from an AI assistant (MCP)

`cove-fi mcp` starts a stdio MCP server exposing sixteen tools so you can
talk through your plan in plain language instead of memorizing CLI flags —
"try retiring at 57", "what if Social Security gets cut 25%", "compare 60
vs 65", "what's my success rate over 1000 simulations":

- **Plan discovery & building:** `list_plans`, `load_plan` (bare saved-plan
  names or a path), `create_plan`, `update_plan`, `save_plan`
- **YNAB seeding:** `seed_from_ynab` (propose-only)
- **Assumptions:** `get_assumptions` (returns `{ assumptions, citations }`),
  `set_assumption`
- **Projection:** `run_projection`, `fi_status`, `run_scenario`,
  `monte_carlo`, `compare_scenarios`
- **Trust & auditing:** `income_gross_from_net` (propose-only take-home ->
  gross calculator), `get_engine_info` (version/capabilities handshake),
  `audit_cash_flow` (per-year income/expense/tax table with duplicate-line
  and funding-shortfall flags)

As with the CLI `scenario` command, `run_scenario`'s `retirement_year`
override moves any income whose `end = "retirement"` right along with it —
no separate plan edit needed.

Setup is a one-liner per client:

- **Claude Code:** `claude mcp add cove-fi -- npx -y @walensis/cove-fi mcp`
  — see [`docs/clients/claude-code.md`](../../docs/clients/claude-code.md)
- **Claude Desktop:** add a block to `claude_desktop_config.json` — see
  [`docs/clients/claude-desktop.md`](../../docs/clients/claude-desktop.md)
- **Cursor:** add a block to `.cursor/mcp.json` — see
  [`docs/clients/cursor.md`](../../docs/clients/cursor.md)

## Onboarding

Once the server's wired up, just say **"set up my retirement plan."**
Clients that surface MCP prompts can run the `onboard` guided flow
directly; everywhere else, just asking works — the tools are
self-describing. Either path checks `list_plans` for an existing plan,
offers to seed a starting point from YNAB, walks a manual interview for
anything seeding didn't cover, and finishes with `run_projection`,
`fi_status`, a `monte_carlo` run, and a `save_plan`.

Plans are discovered from `~/.cove-fi/plans` (override with the
`COVE_FI_PLANS` environment variable) — `list_plans` also picks up any
`*.toml` files in your current directory. `seed_from_ynab` reads a YNAB
budget through [`@walensis/ynab-client`](https://www.npmjs.com/package/@walensis/ynab-client)
and needs `COVE_FI_YNAB_TOKEN` or `YNAB_TOKEN` set to a YNAB Personal
Access Token; without one it returns `{ configured: false, instructions }`
instead of erroring. Seeding is always **propose-only** — it never writes
to the loaded plan itself, only returns numbers for the assistant to read
back and confirm with you before they go into `create_plan`/`update_plan`.

## Validation status

The engine is validated against published research and primary sources,
not any particular commercial planning tool — closed-form math, cross-plan
invariants, IRS-table pins, and a Monte Carlo benchmark against the
Trinity-study withdrawal-rate literature. See
[`docs/VALIDATION.md`](../../docs/VALIDATION.md) for the full methodology,
citations, and an honest accounting of current limitations (flat effective
tax model, equity + correlated T-bill Monte Carlo with portfolio mixes
planned, no state tax/IRMAA). For the engine's
actual rules — the contribution waterfall, drawdown order, sentinels — see
[`docs/SEMANTICS.md`](../../docs/SEMANTICS.md).

As of 0.4, per-account (`ret`) and per-tax-class (`assumptions.class_returns`)
return overrides sit alongside the global `ret` default — and opting a
cash account into either taxes its growth as ordinary income every year,
rather than letting it compound tax-free. `monte_carlo` treats cash the
same way: cash-class accounts follow a historical T-bill path correlated
with the same sampled market years instead of the equity path everything
else rides, so a cash-heavy plan shows visibly narrower percentile bands.
And `coast_year` is now a true CoastFIRE expectations test — projecting
each account's current balance forward at its own resolved rate to
`retirement_year` and comparing against `fi_multiple x` projected
retirement spending — instead of the old trailing-spend x `coast_multiple`
heuristic, which is deprecated and ignored.

As of 0.5, `run_scenario`/`scenario`/`compare` validate their overrides
strictly — an unrecognized key (top-level, or nested inside
`extra_expenses`/`extra_incomes`/`contributions`) is a validation error
naming it and the supported set, where before 0.5 it was silently
dropped and the scenario ran as an unchanged copy of the base plan; see
`docs/SEMANTICS.md`'s Scenario overrides section if you built scenarios
against an earlier version. Contribution rungs can now carry a `name` and
a `hard_end`, and `run_scenario`'s `overrides.contributions` (or the CLI's
`--contributions-end`/`--contributions-scale`/`--contributions-keep`) can
stop, scale, or exempt individual named rungs instead of only the blanket
`savings_rate_multiplier`. Accounts can also be flagged `earmarked: true`
to save toward a specific goal outside general-purpose net worth — the
balance is excluded from `net_worth`, FI/coast/depletion year, Monte Carlo
success rate, and the retirement drawdown waterfall, reported separately
as `earmarked_net_worth` (and `terminal_earmarked_net_worth` in
`fi_status`), and spent via an expense's `fund_from` rather than the
general drawdown. One honest caveat: dividends on an earmarked *taxable*
account are still taxed to the household every year — the household still
legally owns the account — a deliberate but revisitable call; see
`docs/SEMANTICS.md`'s Earmarked assets section.

As of 0.6, cove-fi plans have always stored GROSS (pre-tax) income, but
nothing enforced it — a plan quietly seeded from take-home deposits (a
YNAB export, a paycheck figure) taxed already-taxed money without any
signal that anything was wrong. This release doesn't touch the engine's
tax model to fix that; instead it adds a propose-only calculator,
`income_gross_from_net`, that converts a take-home figure to gross
(`gross = net / (1 - (income_tax + local_tax)) + deferrals`, reconciling
against a self-reported gross when given) — and wires the `onboard` prompt
to call it automatically, settling gross-vs-take-home, annualizing period
figures, and collecting every pretax deferral before a number ever reaches
`create_plan`/`update_plan`. Two more trust tools land alongside it:
`get_engine_info`, a version/capabilities/metric-definition handshake
callable before any plan is loaded (see `docs/SEMANTICS.md`'s Metric
versioning section for the `METRICS_VERSION` bump obligation it exists to
surface), and `audit_cash_flow`, a per-year table built over a new opt-in
engine `detail` that reconciles exactly to each `YearRow`'s totals and
flags duplicate income/expense line names and `fund_from` funding
shortfalls. All three are additive — `run()`/`YearRow` are unchanged, and
no existing plan's projected numbers move.

## Roadmap

- **0.2** — Monte Carlo simulation (historical block-bootstrap returns)
  instead of a single deterministic path. **Shipped.**
- **0.3** — conversational onboarding (guided interview, plan discovery,
  propose-only YNAB seeding). **Shipped.**
- **0.4** — per-account/per-tax-class return overrides, gated cash-interest
  taxation, correlated T-bill Monte Carlo cash sleeves, true CoastFIRE
  `coast_year`. **Shipped.**
- **0.5** — strict scenario override validation (bug fix), named
  contribution rungs with stop/scale/keep scenario overrides, earmarked
  assets. **Shipped.**
- **0.6** — `income_gross_from_net` (take-home -> gross calculator),
  `get_engine_info` (version/capabilities handshake), opt-in engine
  `detail`, `audit_cash_flow` (per-year audit with duplicate-line/funding-
  shortfall flags). **This release.**
- **Next** — integrations (third-party import/export), bond
  series/portfolio mixes.

Not yet: bond series/portfolio mixes, progressive-bracket taxes,
third-party import/export integrations.

## License

MIT — see [LICENSE](./LICENSE).
