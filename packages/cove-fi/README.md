# @walensis/cove-fi

A deterministic, annual retirement / financial-independence projection
engine. Give it a plan file (accounts, income, expenses, contributions,
Social Security, a house if you have one) and it projects net worth,
income, expenses, taxes, and withdrawals year by year to see when you hit
FI, when you could coast, and whether your money outlives you.

`cove-fi` is the **Project** module of the Cove suite (Balance → Plan →
**Project**), but it's fully standalone — no other Cove tools required. It
ships as a CLI, a library, and an MCP server, so you can run it from a
terminal, script against it, or just talk to it from Claude Desktop, Claude
Code, or Cursor.

The engine is grounded in actuals: its default assumptions and calculation
order aren't picked for elegance, they're calibrated against a real
household's retirement-planning software output (see [Calibration
status](#calibration-status) below) and documented with citations in
[`docs/ASSUMPTIONS.md`](../../docs/ASSUMPTIONS.md).

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

`cove-fi mcp` starts a stdio MCP server exposing seven tools (`load_plan`,
`get_assumptions`, `set_assumption`, `run_projection`, `fi_status`,
`run_scenario`, `compare_scenarios`) so you can talk through your plan in
plain language instead of memorizing CLI flags — "try retiring at 57",
"what if Social Security gets cut 25%", "compare 60 vs 65". As with the CLI
`scenario` command, `run_scenario`'s `retirement_year` override moves any
income whose `end = "retirement"` right along with it — no separate plan
edit needed.

Setup is a one-liner per client:

- **Claude Code:** `claude mcp add cove-fi -- npx -y @walensis/cove-fi mcp`
  — see [`docs/clients/claude-code.md`](../../docs/clients/claude-code.md)
- **Claude Desktop:** add a block to `claude_desktop_config.json` — see
  [`docs/clients/claude-desktop.md`](../../docs/clients/claude-desktop.md)
- **Cursor:** add a block to `.cursor/mcp.json` — see
  [`docs/clients/cursor.md`](../../docs/clients/cursor.md)

## Calibration status

The engine is calibrated against a real household's ProjectionLab export
(see [`docs/CALIBRATION.md`](../../docs/CALIBRATION.md) for the full
methodology — the oracle data itself is private and never committed). Short
version: **the accumulation phase is solid** (net worth and liquid net
worth track the oracle within roughly 0.5–12%, withdrawals match exactly),
but **retirement-phase drawdown still diverges substantially** — our
withdrawal ordering and tax treatment during decumulation is the top open
calibration item. Numbers from `cove-fi` for years before retirement are
trustworthy as an estimate; numbers deep into retirement should be treated
as rough until that's fixed. Track progress in
[`docs/CALIBRATION.md`](../../docs/CALIBRATION.md).

## Roadmap

- **0.2** — Monte Carlo simulation (historical block-bootstrap returns)
  instead of a single deterministic path.
- **0.3** — ProjectionLab import adapter, so you can seed a plan from an
  existing PL export instead of hand-writing TOML.

Not planned for 0.1.0: Monte Carlo, PL import (both above), or an npm
publish beyond this initial release prep.

## License

MIT — see [LICENSE](./LICENSE).
