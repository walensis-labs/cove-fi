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

`cove-fi mcp` starts a stdio MCP server exposing thirteen tools so you can
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
tax model, single-asset Monte Carlo, no state tax/IRMAA). For the engine's
actual rules — the contribution waterfall, drawdown order, sentinels — see
[`docs/SEMANTICS.md`](../../docs/SEMANTICS.md).

## Roadmap

- **0.2** — Monte Carlo simulation (historical block-bootstrap returns)
  instead of a single deterministic path. **Shipped.**
- **0.3** — integrations (third-party import/export), portfolio mixes.

Not yet: bond series/portfolio mixes, progressive-bracket taxes,
third-party import/export integrations (targeted for 0.3).

## License

MIT — see [LICENSE](./LICENSE).
