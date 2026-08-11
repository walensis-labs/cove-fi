# Conventions

These are behavioral conventions discovered by diffing the engine's output
against a private ProjectionLab (PL) Reports export during calibration (see
`docs/CALIBRATION.md`). They aren't arbitrary design choices — they're facts
about how PL itself computes its numbers, reverse-engineered from real
divergence, and then matched in `engine.ts` for parity. Each one is pinned by
a test in `packages/cove-fi/test/engine-conventions.test.ts` so a future
refactor can't silently drift away from it.

1. **Liquid net worth excludes 529s and the house; net worth includes both.**
   `LNW = liquid accounts − mortgage − consumer debt`; `NW = LNW + house
   market value + 529 balances`. Verified exactly against the first-year
   snapshot row of the oracle.
   Guarded by: `engine-conventions.test.ts` → `"1: LNW excludes 529 and
   house; NW includes both"`.

2. **The contribution waterfall is cash-flow constrained, never
   withdrawal-funded.** Rungs fund in priority order for as long as
   `income − taxes − explicit expenses` holds out. No contribution rung ever
   triggers a withdrawal from another account to keep funding itself.
   Guarded by: `engine-conventions.test.ts` → `"2: waterfall is cash-flow
   constrained — never withdraws to fund rungs"`.

3. **Leftover surplus is spent, not saved.** Once contribution rungs are
   satisfied, any remaining cash-flow surplus (`cashFlowDefault: "spend"`)
   lands in the Expenses metric rather than being swept into savings.
   Guarded by: `engine-conventions.test.ts` → `"3: surplus is spent — income
   identity holds every working year"`.

4. **`grow$`-flagged amounts compound from the plan's start year, not from
   the item's own start year.** For example, a monthly premium modeled as
   `grow$` at inflation + 3% keeps compounding continuously from the plan's
   first year even if the expense line itself doesn't begin until later —
   it does not "reset" its growth clock to zero at its own start date.
   Verified against the oracle: enabling this convention shifted a later-year
   expense figure by +0.6% relative to the naive (own-start) compounding.
   Guarded by: `engine-conventions.test.ts` → `"4: nominal_at_start (grow$)
   compounds from plan start vs own start"`.

5. **PL's reported "Contributions" metric appears to exclude 401(k) payroll
   deferrals.** Diffing a single year's contribution total against its
   components, the reported figure decomposed exactly as the sum of HSA +
   529 + taxable-brokerage + partial-Roth contributions — with no line for
   the pretax 401(k) deferral, even though that deferral clearly happened
   (it's what makes the year's pretax rungs reduce the taxable income base).
   Working hypothesis: PL books payroll deferrals under its "Transfers"
   metric instead of "Contributions". The engine models this by having
   pretax rungs (401(k), HSA) reduce the tax base directly rather than
   appearing as a taxed contribution.
   Guarded by: `engine-conventions.test.ts` → `"5: pretax rungs reduce the
   tax base (converged)"`.

See `docs/CALIBRATION.md` for the open items these conventions haven't yet
resolved (retirement-phase drawdown divergence is the big one).
