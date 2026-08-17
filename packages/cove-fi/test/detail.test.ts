/**
 * 0.6.0 Task 3 — opt-in per-year engine detail. Pins:
 *   - detail is undefined by default, and rows are byte-identical whether
 *     or not `{ detail: true }` is passed (the flag must never change any
 *     total).
 *   - RECONCILIATION (fix round after initial review): the detail must
 *     RECONCILE, not merely approximate, its corresponding row total —
 *     that's the whole point of the audit tool it feeds.
 *     - detail.incomes (including the synthetic "Social Security" line)
 *       sums EXACTLY to row.income, every year.
 *     - detail.expenses (including the synthetic "House ...", "Mortgage
 *       (P&I)", and "Discretionary (unallocated surplus)" lines) sums
 *       EXACTLY to row.expenses, every year, on a plan with a mortgage,
 *       house costs, a fund_from expense, and surplus years.
 *     - detail.contributions sums to row.contributions.
 *     - detail.withdrawals sums to row.withdrawals.
 *     - detail.taxes' four components sum to row.taxes.
 *   - a fund_from expense whose account can't cover the full amount
 *     reports a funded_from_account/funded_from_cash_flow split that sums
 *     to the full amount (the fallthrough case the audit tool flags).
 *   - zero-amount entries never appear in any of the four arrays.
 */
import { describe, expect, it } from "vitest";
import { runWithMeta } from "../src/engine.js";
import { syntheticPlan } from "./helpers/synthetic.js";

describe("runWithMeta detail (opt-in)", () => {
  const plan = syntheticPlan();

  it("detail is undefined by default", () => {
    const result = runWithMeta(plan);
    expect(result.detail).toBeUndefined();
  });

  it("rows are byte-identical with and without the detail flag", () => {
    const withoutDetail = runWithMeta(plan);
    const withDetail = runWithMeta(plan, undefined, undefined, { detail: true });
    expect(withDetail.rows).toEqual(withoutDetail.rows);
    expect(withDetail.coast_year).toEqual(withoutDetail.coast_year);
  });

  it("detail is populated, one entry per row, when opts.detail is true", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    expect(result.detail).toBeDefined();
    expect(result.detail!.length).toBe(result.rows.length);
  });

  it("per-year detail.incomes (including Social Security) sums EXACTLY to row.income", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    for (let idx = 0; idx < result.rows.length; idx++) {
      const row = result.rows[idx]!;
      const detail = result.detail![idx]!;
      const incomeSum = detail.incomes.reduce((s, i) => s + i.amount, 0);
      expect(incomeSum, `row ${row.year} income`).toBe(row.income);
      // Once claimed, SS shows up as its own line (not folded silently into
      // a salary line or dropped).
      if (row.year >= plan.social_security[0]!.claim_year) {
        expect(detail.incomes.some((i) => i.name === "Social Security")).toBe(true);
      }
    }
  });

  it("per-year detail.expenses (including synthetic house/mortgage/surplus lines) sums EXACTLY to row.expenses", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    let sawHouse = false;
    let sawMortgage = false;
    let sawSurplus = false;
    for (let idx = 0; idx < result.rows.length; idx++) {
      const row = result.rows[idx]!;
      const detail = result.detail![idx]!;
      const expenseSum = detail.expenses.reduce((s, e) => s + e.amount, 0);
      expect(expenseSum, `row ${row.year} expenses`).toBe(row.expenses);
      for (const e of detail.expenses) {
        if (e.name.startsWith("House (")) sawHouse = true;
        if (e.name === "Mortgage (P&I)") sawMortgage = true;
        if (e.name === "Discretionary (unallocated surplus)") sawSurplus = true;
      }
    }
    // synthetic.ts's plan carries a mortgaged house and leaves cash-flow
    // headroom (see its own comment) — all three synthetic lines must show
    // up somewhere across the horizon, or this test isn't exercising what
    // it claims to.
    expect(sawHouse).toBe(true);
    expect(sawMortgage).toBe(true);
    expect(sawSurplus).toBe(true);
  });

  it("per-year detail.contributions sum equals row.contributions", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    for (let idx = 0; idx < result.rows.length; idx++) {
      const row = result.rows[idx]!;
      const detail = result.detail![idx]!;
      const contribSum = detail.contributions.reduce((s, c) => s + c.amount, 0);
      expect(contribSum, `row ${row.year} contributions`).toBe(row.contributions);
    }
  });

  it("per-year detail.withdrawals sum equals row.withdrawals", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    for (let idx = 0; idx < result.rows.length; idx++) {
      const row = result.rows[idx]!;
      const detail = result.detail![idx]!;
      const withdrawalSum = detail.withdrawals.reduce((s, w) => s + w.amount, 0);
      expect(withdrawalSum, `row ${row.year} withdrawals`).toBe(row.withdrawals);
    }
  });

  it("per-year detail.taxes components sum to row.taxes", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    for (let idx = 0; idx < result.rows.length; idx++) {
      const row = result.rows[idx]!;
      const t = result.detail![idx]!.taxes;
      const taxSum = t.ordinary + t.capital_gains + t.cash_interest + t.social_security;
      expect(taxSum).toBeCloseTo(row.taxes, 6);
    }
  });

  it("a fund_from expense whose account can't cover it reports only the fallthrough as `amount`, cross-referencing the account draw via withdrawals", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    let sawFallthrough = false;
    for (const yd of result.detail!) {
      for (const e of yd.expenses) {
        if (!e.fund_from) continue;
        // `amount` IS the cash-flow portion — never the full nominal
        // obligation (that would double-count the account-covered part,
        // which never touched cash flow and is reconciled separately via
        // `withdrawals`).
        expect(e.funded_from_cash_flow).toBe(e.amount);
        if (e.funded_from_account > 0) {
          // The account-covered part for THIS line shows up as its own
          // withdrawal entry for the same account, same year.
          const draw = yd.withdrawals.find((w) => w.account === e.fund_from);
          expect(draw, `row ${yd.year} withdrawal for ${e.fund_from}`).toBeDefined();
          expect(draw!.amount).toBeCloseTo(e.funded_from_account, 6);
        }
        if (e.amount > 0) {
          sawFallthrough = true;
        }
      }
    }
    // synthetic.ts's college529 (balance 12000) funds a $15000/yr expense
    // for 4 years (2040-2043) — it depletes and falls through by design.
    expect(sawFallthrough).toBe(true);
  });

  it("a fully-covered fund_from expense is omitted from detail.expenses but visible in detail.withdrawals", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    // Early years of the 2040-2043 window: college529 can still cover the
    // full $15k, so no "college" line should appear in expenses even
    // though a full-amount withdrawal is recorded.
    const idx2040 = result.rows.findIndex((r) => r.year === 2040);
    const detail2040 = result.detail![idx2040]!;
    expect(detail2040.expenses.some((e) => e.name === "college")).toBe(false);
    const draw = detail2040.withdrawals.find((w) => w.account === "college529");
    expect(draw).toBeDefined();
    expect(draw!.amount).toBeGreaterThan(0);
  });

  it("zero-amount entries never appear in any of the four arrays", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    for (const yd of result.detail!) {
      for (const i of yd.incomes) expect(i.amount).not.toBe(0);
      for (const e of yd.expenses) expect(e.amount).not.toBe(0);
      for (const c of yd.contributions) expect(c.amount).not.toBe(0);
      for (const w of yd.withdrawals) expect(w.amount).not.toBe(0);
    }
  });
});
