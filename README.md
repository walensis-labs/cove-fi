# cove-fi

Cove FI (`@walensis/cove-fi`) is a deterministic, annual retirement /
financial-independence projection engine — plan files in, a year-by-year
net-worth projection out, with a CLI and an MCP server so you can run it
from a terminal or just talk to it from Claude Desktop, Claude Code, or
Cursor. It's the **Project** module of the Cove suite (Balance → Plan →
**Project**), but works entirely standalone.

Cove for YNAB manages this month's money; Cove FI projects the next forty
years. Each works alone; together they talk.

## Quickstart

```bash
npm install -g @walensis/cove-fi   # or: npx @walensis/cove-fi <command>
cove-fi init my-plan.toml          # scaffold a starter plan
# edit birth_year, salary amount, and retirement_year in my-plan.toml
cove-fi run my-plan.toml           # project it
cove-fi scenario my-plan.toml --retirement-year 2048   # try a scenario
```

Set an income's `end = "retirement"` (the scaffolded salary already is) and
it ends automatically the year before `retirement_year` — including under a
`--retirement-year` scenario override, which moves it too.

Full walkthrough, MCP setup, and command reference:
[`packages/cove-fi/README.md`](./packages/cove-fi/README.md).

## Onboarding

Wire up the MCP server (see [`docs/clients/`](./docs/clients) for
Claude Desktop, Claude Code, and Cursor setup), then just say "set up my
retirement plan." Clients that surface MCP prompts can run the `onboard`
guided flow directly; everywhere else, just asking works — the tools are
self-describing. Either path checks for existing plans, offers YNAB
seeding, walks you through the rest by hand, and finishes with a
projection, a Monte Carlo run, and a save.

Plans are discovered from `~/.cove-fi/plans` (override with
`COVE_FI_PLANS`). YNAB seeding (via `@walensis/ynab-client`) needs
`COVE_FI_YNAB_TOKEN` or `YNAB_TOKEN` set to a YNAB Personal Access Token;
without one, `seed_from_ynab` just says so instead of erroring. Seeding is
always **propose-only** — it never writes to your plan on its own, it
returns numbers for you to confirm before they go into `create_plan` or
`update_plan`.

## Docs

- [`docs/ASSUMPTIONS.md`](./docs/ASSUMPTIONS.md) — every default value and
  its citation
- [`docs/SEMANTICS.md`](./docs/SEMANTICS.md) — the engine's rules: the
  contribution waterfall, drawdown order, sentinels, and more
- [`docs/VALIDATION.md`](./docs/VALIDATION.md) — how the engine is
  validated against published research and primary sources
- [`docs/clients/`](./docs/clients) — MCP setup for Claude Desktop, Claude
  Code, and Cursor

## Validation

The engine is validated against published research and primary sources —
closed-form math, cross-plan invariants, IRS-table pins, and a Monte Carlo
benchmark against the Trinity-study withdrawal-rate literature. See
[`docs/VALIDATION.md`](./docs/VALIDATION.md) for the full methodology,
citations, and an honest accounting of current limitations.

As of 0.4, accounts can carry their own nominal return or default by tax
class instead of a single global rate, and opting a cash account into
either taxes its growth as ordinary income each year, like real interest.
Monte Carlo gives cash sleeves the same honest treatment: they follow a
historical T-bill path correlated with the same sampled market years
instead of riding the equity path like every other account, so cash-heavy
plans get narrower percentile bands. `coast_year` is now a true CoastFIRE
expectations test — does each account's current balance, grown at its own
rate to `retirement_year`, already clear `fi_multiple x` projected
retirement spending — rather than a trailing-spend heuristic.

## Roadmap

- **0.2** — Monte Carlo simulation (historical block-bootstrap returns)
- **0.3** — conversational onboarding (guided interview, plan discovery,
  propose-only YNAB seeding). **Shipped.**
- **0.4** — integrations (third-party import/export), bond
  series/portfolio mixes

## License

MIT — see [LICENSE](./LICENSE).
