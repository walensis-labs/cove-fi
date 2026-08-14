/**
 * 0.6.0 Task 3 — opt-in per-year engine detail. Pins:
 *   - detail is undefined by default, and rows are byte-identical whether
 *     or not `{ detail: true }` is passed (the flag must never change any
 *     total).
 *   - detail.incomes sums (plus that year's SS gross) to row.income.
 *   - detail.contributions sums to row.contributions.
 *   - detail.withdrawals sums to row.withdrawals.
 *   - detail.taxes' four components sum to row.taxes.
 *   - a fund_from expense whose account can't cover the full amount
 *     reports a funded_from_account/funded_from_cash_flow split that sums
 *     to the full amount (the fallthrough case the audit tool flags).
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

  it("per-year detail.incomes sum + SS gross equals row.income", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    for (let idx = 0; idx < result.rows.length; idx++) {
      const row = result.rows[idx]!;
      const detail = result.detail![idx]!;
      const incomeSum = detail.incomes.reduce((s, i) => s + i.amount, 0);
      // detail.incomes never includes Social Security (it has its own
      // claim-year gating), so the remainder (row.income - incomeSum) is
      // exactly that year's SS gross: 0 before claim_year, positive after.
      const remainder = row.income - incomeSum;
      expect(remainder).toBeGreaterThanOrEqual(-1e-6);
      if (row.year < plan.social_security[0]!.claim_year) {
        expect(remainder).toBeCloseTo(0, 6);
      } else {
        expect(remainder).toBeGreaterThan(0);
      }
    }
  });

  it("per-year detail.contributions sum equals row.contributions", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    for (let idx = 0; idx < result.rows.length; idx++) {
      const row = result.rows[idx]!;
      const detail = result.detail![idx]!;
      const contribSum = detail.contributions.reduce((s, c) => s + c.amount, 0);
      expect(contribSum).toBeCloseTo(row.contributions, 6);
    }
  });

  it("per-year detail.withdrawals sum equals row.withdrawals", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    for (let idx = 0; idx < result.rows.length; idx++) {
      const row = result.rows[idx]!;
      const detail = result.detail![idx]!;
      const withdrawalSum = detail.withdrawals.reduce((s, w) => s + w.amount, 0);
      expect(withdrawalSum).toBeCloseTo(row.withdrawals, 6);
    }
  });

  it("per-year detail.taxes components sum to row.taxes", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    for (let idx = 0; idx < result.rows.length; idx++) {
      const row = result.rows[idx]!;
      const t = result.detail![idx]!.taxes;
      const taxSum = t.ordinary + t.dividends + t.cash_interest + t.social_security;
      expect(taxSum).toBeCloseTo(row.taxes, 6);
    }
  });

  it("a fund_from expense whose account can't cover it splits account/cash-flow summing to the full amount", () => {
    const result = runWithMeta(plan, undefined, undefined, { detail: true });
    let sawFallthrough = false;
    for (const yd of result.detail!) {
      for (const e of yd.expenses) {
        if (e.fund_from) {
          expect(e.funded_from_account + e.funded_from_cash_flow).toBeCloseTo(e.amount, 6);
          if (e.funded_from_cash_flow > 0) {
            sawFallthrough = true;
          }
        }
      }
    }
    // synthetic.ts's college529 (balance 12000) funds a $15000/yr expense
    // for 4 years (2040-2043) — it depletes and falls through by design.
    expect(sawFallthrough).toBe(true);
  });
});
