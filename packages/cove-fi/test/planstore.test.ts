import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPlans, plansDir, resolvePlanRef, savePlan } from "../src/planstore.js";
import { syntheticPlan } from "./helpers/synthetic.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "covefi-store-")); vi.stubEnv("COVE_FI_PLANS", dir); });
afterEach(() => vi.unstubAllEnvs());

describe("planstore", () => {
  it("plansDir honors COVE_FI_PLANS", () => expect(plansDir()).toBe(dir));
  it("listPlans on empty/missing dir returns [] and creates nothing", () => {
    vi.stubEnv("COVE_FI_PLANS", join(dir, "nope"));
    expect(listPlans()).toEqual([]);
    expect(existsSync(join(dir, "nope"))).toBe(false);
  });
  it("savePlan writes, listPlans finds, resolvePlanRef round-trips", () => {
    const p = savePlan("my-plan", syntheticPlan());
    expect(p).toBe(join(dir, "my-plan.toml"));
    expect(listPlans().map(e => e.name)).toContain("my-plan");
    expect(resolvePlanRef("my-plan")).toBe(p);
  });
  it("bare ref vs path ref", () => {
    expect(resolvePlanRef("x")).toBe(join(dir, "x.toml"));
    expect(resolvePlanRef("./x.toml")).toContain("x.toml");
    expect(resolvePlanRef("/abs/x.toml")).toBe("/abs/x.toml");
  });
  it("rejects traversal and bad slugs", () => {
    for (const bad of ["../evil", "a/b", ".hidden", "x".repeat(65)])
      expect(() => savePlan(bad, syntheticPlan()), bad).toThrow();
  });
  it("refuses overwrite unless asked", () => {
    savePlan("dup", syntheticPlan());
    expect(() => savePlan("dup", syntheticPlan())).toThrow(/exists/i);
    expect(() => savePlan("dup", syntheticPlan(), { overwrite: true })).not.toThrow();
  });
});
