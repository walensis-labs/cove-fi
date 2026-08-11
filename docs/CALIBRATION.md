# Calibration

## Baseline status — Python reference v0.2 (frozen 2026-08-11)

The engine is calibrated against a ProjectionLab Reports export of a real plan
(the maintainer's). That oracle, the transcribed fixture, and the frozen
year-by-year baseline table are **private** — they contain real financial data
and live outside the public tree (`private/`, gitignored; maintainers see
`private/baseline.md`). What is public is the calibration *state* and the
conventions it produced (see CONVENTIONS.md).

State at freeze, relative errors vs the oracle:

- **Accumulation phase (2027–2051):** net worth and liquid net worth within
  ~0.5–12% (mean drift grows late in the phase); withdrawals exact;
  taxes +4.6%; contributions +6.4%.
- **Retirement phase (2052+):** diverges badly — our liquid NW depletes to
  zero by 2070 while PL sustains it indefinitely. Open item 1.
- **First partial year (2026):** expenses −57.5% — crude mid-year fraction,
  open item 5, expected.
- Full series: NW mean |Δ| 31.0% (max 65.6%), LNW mean |Δ| 52.6% (max 100%) —
  dominated entirely by the retirement-phase divergence.

**The TypeScript port must reproduce the frozen baseline (< $1/cell on engine
output) before any calibration work begins.** Intentional calibration
improvements update the private baseline in the same commit, with a note here.

## Open calibration items (priority order)

1. **Retirement drawdown taxes/order** — drawdown must exhaust taxable BASIS,
   then free Roth contributions, then trad; our flat gross-up spiral applies
   31% to all trad draws, overstating retirement taxes by an order of
   magnitude. Also: spousal SS (spouse with PIA 0 + estimateIncome likely
   derives ~50% of primary PIA), and an excess-cash bucket PL routes surplus
   RMD/income into. Cross-validate fixes against **Owl** as a second oracle
   (design §10).
2. **Working-year expenses −10.6%** — PL books more annual expense than
   income − taxes − contributions allows; suspect employer match / payroll
   asymmetry. Blocked on understanding PL's "Transfers" metric.
3. **Income −1.8%** — constant small gap; likely a growth-timing convention
   (inflation applied from mid-first-year?).
4. **Coast-fi phase switch** — verify which contribution rungs PL actually
   retires, and when.
5. **First partial year** — needs a proper mid-year convention (current
   fraction is crude).

Target: mean |Δ| < 2% across the full series. Log each discovered convention
in CONVENTIONS.md.

## Running the harness

- Python reference: `cd ~/develop/cove-fi-python-reference && python3 validate.py <reports.json>`
- TypeScript (once ported): `scripts/validate.ts`, reads private paths from
  env (`COVE_FI_PRIVATE_EXPORT`, `COVE_FI_PRIVATE_FIXTURE`); local-only — CI
  never sees the oracle and skips these suites by construction.

### TypeScript harness

`pnpm validate` (root script) builds the package and runs
`scripts/validate.ts`, reading the private fixture and oracle report from
`COVE_FI_PRIVATE_PLAN` and `COVE_FI_PRIVATE_REPORT` respectively. As of
commit `d35a526`, the TypeScript engine reproduces the frozen baseline in
`private/baseline.md` exactly — same deltas, same divergence pattern,
row for row. Any future difference between a `pnpm validate` run and that
baseline is a TS/Python parity bug, not a calibration change, and must be
fixed before any calibration work proceeds.
