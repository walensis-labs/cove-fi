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

  // 0.5.0: Contribution.name/hard_end and Account.earmarked are additive
  // fields — verify TOML round-trips them rather than assuming smol-toml's
  // generic object handling does the right thing.
  it("Contribution.name and hard_end round-trip through TOML", () => {
    const p = syntheticPlan();
    p.contributions[0]!.name = "match-401k";
    p.contributions[0]!.hard_end = 2060;
    const loaded = loadPlan(dumpPlan(p));
    expect(loaded.contributions[0]!.name).toBe("match-401k");
    expect(loaded.contributions[0]!.hard_end).toBe(2060);
  });

  it("Contribution.name/hard_end absent on other rungs stay absent after round-trip", () => {
    const p = syntheticPlan();
    p.contributions[0]!.name = "match-401k";
    const loaded = loadPlan(dumpPlan(p));
    expect(loaded.contributions[1]!.name).toBeUndefined();
    expect(loaded.contributions[1]!.hard_end).toBeUndefined();
  });

  it("Account.earmarked round-trips through TOML", () => {
    const p = syntheticPlan();
    // college529 is already liquid:false in the synthetic fixture, so
    // marking it earmarked can't trip the earmarked+liquid:true rejection.
    const idx = p.accounts.findIndex((a) => a.name === "college529");
    expect(idx).toBeGreaterThanOrEqual(0);
    p.accounts[idx]!.earmarked = true;
    const loaded = loadPlan(dumpPlan(p));
    expect(loaded.accounts[idx]!.earmarked).toBe(true);
    expect(loaded.accounts[idx]!.liquid).toBe(false);
  });
});
