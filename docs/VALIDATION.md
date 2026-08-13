# Validation

## Philosophy

`cove-fi`'s correctness claims rest on published research and primary
sources — never on agreement with any particular commercial planning
tool. Every default assumption is cited (see
[`docs/ASSUMPTIONS.md`](./ASSUMPTIONS.md)); every behavioral claim about
the engine is either provable in closed form, checkable as an invariant
over arbitrary plans, pinned against a primary-source table, or benchmarked
against a published empirical result. If a test can't be justified by one
of those four grounds, it doesn't belong in the suite.

## The four layers

**1. Closed-form.** Where the engine's output has an exact analytic
solution, the test computes that solution independently and compares —
compound growth (`B_n = B_0(1+r)^n`), mortgage amortization against the
standard loan-annuity formula, and today's-dollars income indexing at
exactly `(1 + inflation)` per year.
`packages/cove-fi/test/validation/closed-form.test.ts`

**2. Conservation & properties.** Invariants that must hold across any
valid plan, not just a specific fixture: the working-year cash-flow
identity (`income ≈ taxes + contributions + expenses`, surplus always
spent, never negative beyond a small deficit tolerance — see Known
limitations), no `NaN`/`Infinity` anywhere in engine output, and
determinism (same input → byte-identical output). Directional properties
— higher returns produce higher terminal net worth, later retirement
delays or matches depletion, higher expenses lower terminal net worth —
are checked the same way, over a shared synthetic plan.
`packages/cove-fi/test/validation/conservation.test.ts`,
`packages/cove-fi/test/validation/monotonicity.test.ts`

**3. Primary-source pins.** Constants copied from a primary source are
checked against that source verbatim, so a transcription slip fails loudly:
RMD divisors against the IRS Uniform Lifetime Table, and 2026 contribution
limits against the IRS's own COLA announcements.
`packages/cove-fi/test/validation/sources.test.ts`

**4. Benchmark.** Monte Carlo output is checked against a published
empirical result from the retirement-withdrawal-rate literature, not an
internally-chosen target.
`packages/cove-fi/test/montecarlo.test.ts`

## Citations

- Cooley, P. L., Hubbard, C. M., & Walz, D. T. (1998). *"Retirement
  Savings: Choosing a Withdrawal Rate That Is Sustainable."* AAII Journal
  — the "Trinity study." Source of the ~98% historical success rate for a
  4% initial withdrawal, 100% stocks, 30-year horizon, and of the
  `fi_multiple = 25` (`1/0.04`) default. (`coast_multiple` is 0.4-
  deprecated and read nowhere — coast now derives from this same
  `fi_multiple` threshold, projected to `retirement_year`, rather than its
  own separate multiple.)
- Bengen, W. P. (1994). *"Determining Withdrawal Rates Using Historical
  Data."* Journal of Financial Planning. Establishes the direction the
  benchmark test also checks: success rate falls as the withdrawal rate
  rises.
- Blanchett, D. M. (2014). *"Estimating the True Cost of Retirement."*
  Morningstar / PWL Capital. Source for `SPENDING_SMILE_FLAG`
  (`src/defaults.ts`) — the empirical "spending smile" (real spending
  declines through the go-go/slow-go years, then rises late in life with
  healthcare costs). **Reserved, OFF by default** — the engine does not
  read this flag yet and projects flat real spending.
- Irlam, G. and the `owlplanner` project
  (github.com/open-source-retirement-planning/owlplanner) — open-source
  Monte Carlo retirement-planning methodology cited here as related open
  research, not as a target the engine is calibrated against.
- Data: Aswath Damodaran, NYU Stern (historical S&P 500 total returns) and
  US BLS CPI-U (Consumer Price Index for All Urban Consumers, via FRED
  series CPIAUCNS) for inflation — both vendored in
  `packages/cove-fi/src/data/returnsAnnual.ts` with full attribution and
  source URLs in that file's header.
- IRS Publication 590-B (2024 rev.), Appendix B, Table III — Uniform
  Lifetime Table, source for `RMD_TABLE`.
- IRS Notice 2025-67 — 2026 401(k)/IRA contribution-limit COLA.
- Rev. Proc. 2025-19 — 2026 HSA contribution-limit COLA.

## The Monte Carlo benchmark, honestly

The withdrawal-rate benchmark test runs the engine's block-bootstrap Monte
Carlo (`packages/cove-fi/src/montecarlo.ts`) against the textbook Trinity
scenario — 100% stocks, $1M portfolio, $40k initial withdrawal (4%),
30-year horizon — and asserts success in **[0.85, 1.0]**. At the pinned
benchmark seed (2,000 trials, seed `20260812`) it lands at **≈0.89**
(0.8945), versus the ~98% the historical-window Trinity study reports for
the same nominal scenario.

That gap is expected, not a bug: the two methodologies aren't measuring
the same thing. Cooley/Hubbard/Walz test a small number of *overlapping,
contiguous* 30-year historical windows (e.g. 1928–1957, 1929–1958, ...) —
each one preserves the real sequence of market history, including the
autocorrelation between consecutive years that a real 30-year retirement
would actually experience. This engine's Monte Carlo instead **block
bootstraps**: it samples 5-year blocks of historical returns *with
replacement* and stitches them together in random order
(`sampleSchedule()` in `montecarlo.ts`). That breaks sequence continuity
at every block boundary — a bootstrapped 30-year path can splice, say, the
end of a bull run directly onto the start of a different bear market in a
combination that never happened historically, or repeat a bad stretch
(like 1929–1933) more than once in the same trial. Bootstrapped paths
therefore sample a wider, harder tail of possible sequences-of-returns
than the finite set of *actual* historical 30-year windows did — which
mechanically produces a lower success rate for the same 4% rule. A
[0.85, 1.0] band, not a tight pin to 0.98, is the correct assertion for
that reason; treat a value falling *outside* that band as an engine or MC
defect to investigate, never as a bound to widen to fit a bad run.

## Known limitations

Stated plainly, not buried:

- **Flat effective tax model.** `income_tax`, `local_tax`, and
  `cap_gains_tax` are single flat rates applied to the whole relevant
  base — no brackets, no phase-outs, no filing-status logic. A real
  progressive-bracket implementation (the `FlatTax` seam) is future work.
- **Two-asset-class Monte Carlo, no glide path.** As of 0.4, the
  bootstrap draws `{ ret, inflation, cash_ret }` per sampled year — an
  equity return (S&P 500) and a T-bill return, from the SAME historical
  index, so a trial's cash sleeve stays correlated with that trial's
  equity/inflation path. Cash-class accounts follow `cash_ret`; every
  other tax class follows the equity `ret`. That's a partition by
  account class, not a real portfolio mix: there's still no bond series,
  no user-defined asset allocation within an invested (non-cash) class,
  and no glide path (allocation shifting over time) — an account is
  either "equity" or "cash" for the whole run. Broader per-class
  portfolio mixes are planned, not yet implemented.
- **No state tax or IRMAA.** Federal-shaped flat rates only; state income
  tax and Medicare IRMAA surcharges are not modeled.
- **Working-year deficits are not funded.** The contribution waterfall is
  strictly cash-flow constrained (see
  [`docs/SEMANTICS.md`](./SEMANTICS.md)) — it never triggers a withdrawal
  to keep a rung funded. A working year where a timing wedge (e.g. a large
  one-time expense) outruns available cash flow produces a small negative
  residual in the income identity rather than an automatic withdrawal;
  `conservation.test.ts` bounds this at -$20,000 for the shared synthetic
  fixture and treats anything worse as a regression.
- **Reserved-but-unwired fields.** `Income.reduces_by_pretax` and
  `Plan.drawdown_order` are accepted by the schema and carried through
  `normalizePlan()`, but the engine does not currently read either one —
  income reduction from pretax contributions and drawdown ordering both
  use fixed internal logic instead. Setting these fields has no effect on
  engine output yet.
