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

Note: `--retirement-year` moves the work/retirement boundary only — it
doesn't shorten any income event's own `end` date, so for a full
early-retirement what-if, shorten your salary's `end` year in the plan too.
See [`packages/cove-fi/README.md`](./packages/cove-fi/README.md) for the
full explanation.

Full walkthrough, MCP setup, and command reference:
[`packages/cove-fi/README.md`](./packages/cove-fi/README.md).

## Docs

- [`docs/ASSUMPTIONS.md`](./docs/ASSUMPTIONS.md) — every default value and
  its citation
- [`docs/CALIBRATION.md`](./docs/CALIBRATION.md) — how the engine is
  validated and where it currently diverges
- [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) — behavioral conventions
  discovered during calibration, each pinned by a test
- [`docs/clients/`](./docs/clients) — MCP setup for Claude Desktop, Claude
  Code, and Cursor

## Calibration status

The engine is calibrated against a real household's ProjectionLab export
(methodology and current numbers in
[`docs/CALIBRATION.md`](./docs/CALIBRATION.md); the oracle data itself is
private and never committed). **The accumulation phase is solid** — net
worth and liquid net worth track the oracle within roughly 0.5–12%,
withdrawals match exactly. **Retirement-phase drawdown still diverges
substantially** — withdrawal ordering and tax treatment during decumulation
is the top open calibration item, in progress. Treat pre-retirement numbers
as trustworthy estimates and deep-retirement numbers as rough for now.

## Roadmap

- **0.2** — Monte Carlo simulation (historical block-bootstrap returns)
- **0.3** — ProjectionLab import adapter

## License

MIT — see [LICENSE](./LICENSE).
