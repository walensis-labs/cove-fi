import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.js";
import { syntheticPlan } from "./helpers/synthetic.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "covefi-session-plans-"));
  vi.stubEnv("COVE_FI_PLANS", dir);
});
afterEach(() => vi.unstubAllEnvs());

describe("Session.createPlan", () => {
  it("creates from the synthetic plan JSON and returns matching summary counts", () => {
    const session = new Session();
    const plan = syntheticPlan();
    const summary = session.createPlan(plan);
    expect(summary.accounts).toBe(plan.accounts.length);
    expect(summary.incomes).toBe(plan.incomes.length);
    expect(summary.expenses).toBe(plan.expenses.length);
    expect(summary.contributions).toBe(plan.contributions.length);
    expect(summary.birth_year).toBe(plan.birth_year);
    expect(summary.retirement_year).toBe(plan.assumptions.retirement_year);
    expect(session.plan).not.toBeNull();
    expect(session.planPath).toBeNull();
    expect(session.dirty).toBe(true);
  });

  it("throws with issues[] text on garbage input", () => {
    const session = new Session();
    try {
      session.createPlan({ nonsense: true });
      throw new Error("expected createPlan to throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/birth_year/i);
      expect((err as { issues?: string[] }).issues).toBeDefined();
      expect((err as { issues: string[] }).issues.length).toBeGreaterThan(0);
    }
    expect(session.plan).toBeNull();
  });
});

describe("Session.updatePlan", () => {
  it("add appends to an array field (accounts)", () => {
    const session = new Session();
    const plan = syntheticPlan();
    session.createPlan(plan);
    const before = session.plan!.accounts.length;
    const summary = session.updatePlan({
      add: { accounts: [{ name: "extra-savings", tax: "cash", balance: 500 }] },
    });
    expect(session.plan!.accounts.length).toBe(before + 1);
    expect(session.plan!.accounts.at(-1)!.name).toBe("extra-savings");
    expect(summary.accounts).toBe(before + 1);
    expect(session.dirty).toBe(true);
  });

  it("set replaces top-level fields, and shallow-merges assumptions", () => {
    const session = new Session();
    const plan = syntheticPlan();
    session.createPlan(plan);
    const summary = session.updatePlan({
      set: { birth_year: 1985, assumptions: { retirement_year: 2060 } },
    });
    expect(session.plan!.birth_year).toBe(1985);
    expect(session.plan!.assumptions.retirement_year).toBe(2060);
    // shallow merge: other assumption fields survive untouched
    expect(session.plan!.assumptions.inflation).toBe(plan.assumptions.inflation);
    expect(summary.birth_year).toBe(1985);
    expect(summary.retirement_year).toBe(2060);
  });

  it("throws on add to a non-array field with a named issue, and leaves the session plan untouched (atomicity)", () => {
    const session = new Session();
    const plan = syntheticPlan();
    session.createPlan(plan);
    const before = session.plan;
    const beforeProjection = session.runProjection();
    expect(() => session.updatePlan({ add: { birth_year: 1985 } })).toThrow(/birth_year/i);
    expect(session.plan).toEqual(before);
    const afterProjection = session.runProjection();
    expect(afterProjection).toEqual(beforeProjection);
  });

  it("invalid patch (unknown account in a contribution) throws AND runProjection still works on the pre-patch plan", () => {
    const session = new Session();
    const plan = syntheticPlan();
    session.createPlan(plan);
    const before = session.plan;
    const beforeProjection = session.runProjection();
    expect(() =>
      session.updatePlan({
        add: {
          contributions: [{ account: "does-not-exist", start: 2026, end: 2030, amount: 1000 }],
        },
      }),
    ).toThrow();
    // atomic: session plan bit-identical to before the failed patch
    expect(session.plan).toEqual(before);
    expect(() => session.runProjection()).not.toThrow();
    const afterProjection = session.runProjection();
    expect(afterProjection).toEqual(beforeProjection);
  });
});

describe("Session.saveCurrentPlan", () => {
  it("writes via planstore (stubbed env dir) and clears dirty", () => {
    const session = new Session();
    const plan = syntheticPlan();
    session.createPlan(plan);
    expect(session.dirty).toBe(true);
    const path = session.saveCurrentPlan("my-session-plan");
    expect(path).toBe(join(dir, "my-session-plan.toml"));
    expect(session.dirty).toBe(false);
    expect(session.planPath).toBe(path);
  });
});
