import { describe, expect, it } from "vitest";
import { RETIREMENT } from "../src/model.js";
import { dumpPlan, initTemplate, loadPlan, PlanfileError } from "../src/planfile.js";
import { syntheticPlan } from "./helpers/synthetic.js";

describe("planfile", () => {
  it("round-trips load(dump(plan)) losslessly", () => {
    const p = syntheticPlan();
    expect(loadPlan(dumpPlan(p))).toEqual(p);
  });
  it("init template parses and runs", () => {
    const p = loadPlan(initTemplate());
    expect(p.accounts.length).toBeGreaterThan(0);
  });
  it("unknown account in contribution -> PlanfileError naming it", () => {
    const bad = dumpPlan(syntheticPlan()).replace(/account = "401k"/, 'account = "401kk"');
    expect(() => loadPlan(bad)).toThrowError(/401kk/);
  });
  it("end < start -> error with context", () => {
    const p = syntheticPlan();
    p.incomes[0]!.end = p.incomes[0]!.start - 1;
    expect(() => loadPlan(dumpPlan(p))).toThrowError(/end.*start|start.*end/i);
  });
  it('income.end = "retirement" round-trips through the RETIREMENT (-2) sentinel', () => {
    const p = syntheticPlan();
    p.incomes[0]!.end = RETIREMENT;
    const dumped = dumpPlan(p);
    expect(dumped).toMatch(/end = "retirement"/);
    const loaded = loadPlan(dumped);
    expect(loaded.incomes[0]!.end).toBe(RETIREMENT);
  });
  it("RETIREMENT sentinel on an expense.end -> PlanfileError naming it", () => {
    const p = syntheticPlan();
    p.expenses[0]!.end = RETIREMENT;
    expect(() => loadPlan(dumpPlan(p))).toThrowError(/RETIREMENT/);
  });
});
