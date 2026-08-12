# cove-fi

A deterministic, annual retirement / financial-independence projection
engine — plan files in, a year-by-year net-worth projection out, with a CLI
and an MCP server so you can run it from a terminal or just talk to it from
Claude Desktop, Claude Code, or Cursor. It's the **Project** module of the
Cove suite (Balance → Plan → **Project**), but works entirely standalone.

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

## Roadmap

- **0.2** — Monte Carlo simulation (historical block-bootstrap returns)
- **0.3** — integrations (third-party import/export), portfolio mixes

## License

MIT — see [LICENSE](./LICENSE).
