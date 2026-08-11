# cove-fi — Design

**Date:** 2026-08-11
**Status:** Approved by AJ (pending written-spec review)
**Supersedes:** the Claude Desktop HANDOFF.md where they conflict; carries its engine-level requirements forward otherwise.

## 1. What this is

cove-fi is the **Project** module of the Cove suite (Balance → Plan → Project): a
deterministic + Monte Carlo retirement/FI projection engine, standalone-first,
whose v1 interaction model is conversational what-ifs ("try retirement at 57")
through MCP tools. A UI layer may consume the same API later.

The working prototype is a Python engine built in Claude Desktop, calibrated by
reverse-engineering ProjectionLab's computation conventions against a Reports
export of AJ's real plan. That prototype is the **reference implementation**;
the shipped product is a TypeScript port validated against the same oracle.

## 2. Decision log

Every decision below was reviewed explicitly (2026-08-11), replacing the
HANDOFF's assumptions or resolving its reserved items.

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Open/closed seam | Mirror Cove for YNAB: engine + CLI + MCP server fully open; monetize via closed hosted layer later | Local-first privacy is a feature for a tool you feed your net worth into. The engine is a commodity; *your data flowing through it automatically* (YNAB-grounded projections via Cove) is the paid product. Hosted/remote MCP + UI are the other paid surfaces. |
| 2 | Brand & org | Cove suite module: `walensis-labs/cove-fi`, public | Suite story (Balance → Plan → Project) is the moat; standalone-usable regardless. |
| 3 | Language | **TypeScript** (port from Python reference) | Paid tier runs on Cloudflare Workers (cove-cloud) — Python can't. One stack for a solo maintainer; fitness-tools already proved the polyglot path gets abandoned. Isomorphic engine enables future client-side browser UI (privacy win). Math analysis found no Python advantage for anything on the committed roadmap; optimization (the one Python-favored future) gets an escape hatch (see §10). |
| 4 | Release scope | 0.1.0 = engine parity + plan file + CLI + MCP. 0.2.0 = Monte Carlo. 0.3.0 = PL import adapter | Installable product soonest; one headline per release; changesets make cadence cheap. |
| 5 | License | MIT | Matches cove-for-ynab; one license story across the suite. |
| 6 | MC data | Annual US equity returns from Damodaran (NYU) + CPI from FRED, vendored as a small attributed CSV (1928+) | Same coverage as Shiller for annual-block bootstrap with no redistribution ambiguity. |
| 7 | Plan file format | TOML via `smol-toml` | Best hand-editing UX (comments — "Cargo.toml for your finances"); no YAML type-coercion footguns; Python-stdlib motivation for TOML is moot in TS but the format still wins on merits. |
| 8 | Package name | `@walensis/cove-fi` on npm (verified available; `cove-fi` unscoped also free) | Matches `@walensis/cove-core` convention. |
| 9 | Owl (owlplanner, GPL-3.0) | Three GPL-safe uses: (a) dev-time **second oracle** for drawdown/tax calibration, run locally, never distributed; (b) reimplement ideas from its paper + IRS primary sources (never copy code/tables); (c) future Python optimization microservice may wrap Owl behind a process/HTTP boundary — that service is GPL and separate, MIT core stays clean | Owl has done heavy lifting on withdrawal sequencing/taxes — exactly where the engine currently diverges from PL. GPL restricts distribution, not use. |
| 10 | ProjectionLab role | Calibration oracle (frozen private JSON) + optional import adapter. Never a dependency; nothing in engine/planfile/MCP knows PL exists | Bootstrapping, not coupling. Durable artifacts are the extracted conventions pinned as tests on synthetic plans. |

## 3. Repo & stack

Mirrors cove-for-ynab: pnpm workspace, changesets, GitHub Actions. Node ≥ 20.

```
cove-fi/
  pnpm-workspace.yaml
  package.json                 # workspace root
  tsconfig.base.json
  LICENSE                      # MIT
  README.md                    # user-facing quickstart (<5 min)
  packages/
    cove-fi/                   # @walensis/cove-fi, bin: cove-fi
      src/
        model.ts               # typed plan model (port of model.py)
        engine.ts              # annual simulator (port of engine.py)
        defaults.ts            # literature-cited defaults, one place
        planfile.ts            # TOML load/dump + validation
        session.ts             # plan + named scenario overlays (shared by CLI & MCP)
        montecarlo.ts          # 0.2.0
        adapters/projectionlab.ts  # 0.3.0
        mcp/server.ts          # transport-agnostic tool defs + stdio entry
        cli.ts                 # commander
      test/
        conventions/           # one pinned test per discovered convention (synthetic plan)
        planfile.test.ts  mcp.test.ts  montecarlo.test.ts  adapters.test.ts
        private/               # parity suites, env-gated, skipped in CI
      data/returns-annual.csv  # Damodaran + FRED, attributed (ships in package)
  examples/
    conventional-65.toml  early-52.toml  coastfire.toml
  docs/
    CONVENTIONS.md             # reverse-engineered PL conventions (living)
    CALIBRATION.md             # frozen baseline table + open items + harness how-to
    ASSUMPTIONS.md             # every default + citation (rendered from defaults.ts)
    clients/claude-desktop.md  claude-code.md  cursor.md
  scripts/validate.ts          # oracle diff harness; reads private paths from env
  private/                     # GITIGNORED: fixture, PL exports, oracle JSON, tripwire patterns
```

The Python reference lands at `~/develop/cove-fi-python-reference` — outside
this repo, never published.

## 4. Phase 0 — recover & freeze (blocks all port work)

1. AJ exports the prototype from Claude Desktop (zip: `cove_fi/`, `validate.py`,
   `README.md`, `fixture_aj.py`, any fixture JSONs — the Desktop sandbox is
   ephemeral; this is the only copy).
2. Land it in `~/develop/cove-fi-python-reference`; run `python3 validate.py`
   against the PL Reports JSON (already in `~/Downloads/2026-08-10-projectionlab-report-summary.json`).
3. Record the output table as the **frozen baseline** in `private/baseline.md`
   (it is real personal data — never in the public tree). docs/CALIBRATION.md
   carries the public calibration state as relative errors only. Copy oracle +
   fixture into `private/`.

## 5. The port (0.1.0)

- `model.py` dataclasses → TS interfaces; `engine.py` → annual simulator.
- Preserve the `FlatTax` seam: tax computation behind a small interface so a
  bracket engine slots in later without touching the simulator loop.
- Nominal-dollar internals; today's-$ conversions only at the reporting edge.
- **Acceptance is oracle-gated:** `scripts/validate.ts` diffs TS engine output
  against the same Reports JSON and must reproduce the frozen baseline within
  float tolerance (< $1 per cell). Identical, not "close."

## 6. Plan file (planfile.ts + defaults.ts)

- TOML mirroring the model: accounts, incomes, social_security, expenses,
  contributions, house, assumptions.
- Loader fails loud with specific messages (unknown account in a contribution
  rung, end < start, overlapping periods) including year/account context.
- Round-trip load → dump → load is lossless.
- `cove-fi init` scaffolds a commented starter from `defaults.ts`.
- Every default constant carries a one-line citation (Blanchett 2014 spending
  smile — optional flag, **off by default** for PL parity; SSA cohort note;
  CAPE caveat). docs/ASSUMPTIONS.md renders the same table.

## 7. One function layer, two thin fronts (session.ts → CLI + MCP)

`session.ts` owns: load plan, named scenario overlays, run projection, FI
status, comparisons. CLI and MCP both wrap it; no logic in either front.

**CLI** (commander): `init`, `run`, `scenario`, `compare`, `check` (plan-file
validation only — the oracle harness is `scripts/validate.ts`, separate), `mcp`;
`mc`, `import-pl` when their releases land. Human tables by default, `--json`
for machines.

**MCP server** (official TS SDK): tool definitions are transport-agnostic;
0.1.0 ships stdio (`cove-fi mcp`) wired via `claude mcp add cove-fi -- npx
@walensis/cove-fi mcp` / Claude Desktop config / Cursor — zero
Anthropic-specific behavior (hard requirement). The same tool defs mount into
a cove-cloud Worker via streamable HTTP later. Tools (compact JSON, rounded,
today's-$ and nominal where relevant):

- `load_plan(path)` · `get_assumptions()` · `set_assumption(key, value)`
- `run_projection(scenario?)` → year table (12-metric shape)
- `fi_status(scenario?)` → FI year, CoastFIRE year, terminal/depletion
- `run_scenario(name, overrides)` — retirement_year, savings_rate_multiplier
  (partial coast), ss_haircut, ss_claim_year, returns, inflation, extra
  expense/income events
- `compare_scenarios(names)` → aligned table + delta narrative fields
- 0.2.0: `monte_carlo(scenario?, trials=1000, seed?)`
- 0.3.0: `import_projectionlab(path)`

No prompts/resources in v1.

## 8. Monte Carlo (0.2.0)

Block bootstrap over the vendored annual return+inflation series: block size 5,
random restart, seedable PRNG (own PCG/mulberry32 — `Math.random` is not
seedable; fixed seed ⇒ byte-identical output). Success = liquid NW > 0 through
end year. Output: success rate + p10/25/50/75/90 trajectories. Default 1,000
trials, < 1 s. Sanity acceptance: success rate moves the right direction as
retirement age moves on the synthetic plan.

## 9. ProjectionLab import adapter (0.3.0)

`adapters/projectionlab.ts`: full exportData JSON (schema 4.6) → Plan. Ports
the transcription logic currently hand-coded in the Python `fixture_aj.py`,
which then becomes *generated output* of this adapter. Handles: two-hop
account-ID indirection, milestone-relative start/end (`beforeCurrentYear`,
milestone refs, dates), `today$` vs `grow$` (grow$ compounds from **plan
start** — verified), fixed-mode tax variables, priorities order,
`first_year_fraction` from `startDate`. Unknown event types: warn, skip, list
in result. Acceptance: adapter(synthetic export) == hand-built equivalent
Plan; adapter(AJ's private export) reproduces the private fixture (env-gated
test).

## 10. Calibration continuation (post-0.1, do not regress)

The five open items from the reference README, priority order:

1. Retirement drawdown tax order — exhaust taxable **basis**, then free Roth
   contributions, then trad (our flat gross-up overstates retirement taxes by
   an order of magnitude vs the oracle; dollar anchors in
   `private/baseline.md`). **Cross-validate against Owl as a second oracle** — this is Owl's home turf and it de-risks
   faithfully reproducing a PL bug.
2. Spousal SS estimation.
3. Excess-cash bucket.
4. The −10.6% working-year expense identity.
5. The −1.8% income gap.

Target: mean |Δ| < 2% full-series vs oracle. Every new convention discovered
is logged in docs/CONVENTIONS.md. `scripts/validate.ts` stays green (vs the
current frozen baseline) throughout; intentional calibration improvements
update the baseline in the same commit with a note.

Future (not scheduled): optimization features (Roth conversion timing,
withdrawal ordering, SS claiming) as a separate **Python microservice** that
may wrap Owl — GPL-isolated behind a process/HTTP boundary, itself open and
GPL, beside cove-cloud. Bracket tax engine implements from IRS primary
sources, slotting into the `FlatTax` seam.

## 11. Testing & CI

- vitest; every README convention = one pinned test on the committed synthetic
  plan (LNW formula reproduces snapshot, waterfall stops at cash-flow, surplus
  lands in expenses, grow$ from plan start, …).
- Env-gated private suites: `COVE_FI_PRIVATE_EXPORT` / `COVE_FI_PRIVATE_FIXTURE`
  point at local files in `private/`; suites skip when unset — excluded from
  CI by construction.
- CI (GitHub Actions): lint + typecheck + vitest on Node 20/22. Changesets for
  versioning/publish.
- `scripts/validate.ts` runs locally only (needs private oracle).

## 12. Privacy & guardrails

- `private/` gitignored; **zero real personal data in tree or package**. The
  npm pack contents are reviewed before first publish.
- Local pre-commit tripwire greps staged files against a pattern list kept in
  `private/tripwire.txt` (the HANDOFF's suggestion of grepping for real
  balances in CI would have published the balances; inverted — patterns stay
  private, hook stays local).
- No GPL code or tables in the package (Owl per decision #9).
- No browser automation in this package (PL live-sync is a hypothetical
  separate component).
- Client-agnostic MCP: no Anthropic-specific behavior in server code.

## 13. Error handling

Loader/adapter: fail loud, specific, actionable. Engine: never silently clamp —
impossible states (contribution to unknown account, negative balance in a
no-overdraft account) throw with year + account context. MCP tools return
structured errors, never crash the server.

## 14. Definition of done (0.1.0)

- [ ] Phase 0: baseline frozen in `private/baseline.md` from the recovered Python reference; public state in docs/CALIBRATION.md
- [ ] `pnpm install && pnpm build && pnpm test` green in CI
- [ ] `scripts/validate.ts` reproduces frozen baseline < $1/cell (local, private oracle)
- [ ] `npx @walensis/cove-fi init && npx @walensis/cove-fi run my-plan.toml` works in a clean dir
- [ ] `cove-fi mcp` connects from Claude Desktop AND one non-Claude client (Cursor)
- [ ] All three example plans run end-to-end
- [ ] Docs: README quickstart < 5 min; docs/clients/*; CONVENTIONS, CALIBRATION, ASSUMPTIONS present
- [ ] `npm pack` contents audited: no personal data, no private/ leakage

## 15. Non-goals (v1)

- No UI (future product on the same API)
- No hosted/remote MCP in this repo (cove-cloud, later, imports the engine)
- No YNAB integration in this repo (that's the paid Cove integration)
- No bracket taxes (FlatTax default; seam reserved), no state taxes, no IRMAA
- No PL live-sync/browser automation
