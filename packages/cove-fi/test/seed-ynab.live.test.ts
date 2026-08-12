/**
 * Env-gated live smoke test for seed_from_ynab — hits the REAL YNAB API,
 * so it's skipped unless COVE_FI_YNAB_TOKEN is actually set (never true in
 * CI). Kept in its own file, unmocked, so it can coexist with
 * test/seed-ynab.test.ts's `vi.mock("@walensis/ynab-client")` — see that
 * file's note on `vi.mock`/`vi.unmock` hoisting for why they can't share a
 * file. Only shape is asserted; no dollar figures, names, or other real
 * account values are ever printed or logged.
 */
import { describe, expect, it } from "vitest";
import { seedFromYnab } from "../src/seed/ynab.js";

describe.skipIf(!process.env.COVE_FI_YNAB_TOKEN)("seedFromYnab (live smoke)", () => {
  it("returns a well-shaped proposal against the real YNAB API", async () => {
    const proposal = await seedFromYnab();

    expect(typeof proposal.configured).toBe("boolean");
    if (proposal.configured) {
      expect(typeof proposal.budget_name).toBe("string");
      expect(typeof proposal.months_analyzed).toBe("number");
      expect(Array.isArray(proposal.monthly_spending_by_group)).toBe(true);
      expect(Array.isArray(proposal.detected_income)).toBe(true);
      expect(typeof proposal.estimated_annual_expenses).toBe("number");
      expect(typeof proposal.estimated_savings_rate).toBe("number");
      expect(proposal.estimated_savings_rate).toBeGreaterThanOrEqual(0);
      expect(proposal.estimated_savings_rate).toBeLessThanOrEqual(1);
    } else {
      expect(typeof proposal.instructions).toBe("string");
    }
  }, 30_000);
});
