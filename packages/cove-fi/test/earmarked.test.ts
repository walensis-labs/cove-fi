/**
 * Validation shell for the 0.5.0 additive schema fields:
 *   - Contribution.name (optional, non-empty, unique among named rungs)
 *   - Contribution.hard_end (optional, plain finite integer year — COAST/
 *     RETIREMENT sentinels rejected)
 *   - Account.earmarked (optional, default false; earmarked + explicit
 *     liquid:true is rejected)
 *
 * Engine does not read any of these fields yet (0.5.0 Task 3) — this file
 * only exercises normalizePlan()'s defaulting and planFromJson()'s
 * validation.
 */
import { describe, expect, it } from "vitest";
import { COAST, normalizePlan, RETIREMENT, type Plan } from "../src/model.js";
import { planFromJson } from "../src/planjson.js";
import { syntheticPlan } from "./helpers/synthetic.js";

// syntheticPlan() is already normalized (built via normalizePlan), and
// already valid per planFromJson — deep-clone it so each test can mutate
// its own copy without cross-test bleed.
const basePlan = (): Plan => JSON.parse(JSON.stringify(syntheticPlan()));

describe("Account.earmarked — normalizePlan defaults", () => {
  it("defaults to false when absent", () => {
    const p = normalizePlan(basePlan());
    expect(p.accounts.every((a) => a.earmarked === false)).toBe(true);
  });

  it("earmarked:true forces liquid:false even when liquid is absent", () => {
    const raw = basePlan();
    delete (raw.accounts[0] as { liquid?: boolean }).liquid;
    raw.accounts[0]!.earmarked = true;
    const p = normalizePlan(raw);
    expect(p.accounts[0]!.earmarked).toBe(true);
    expect(p.accounts[0]!.liquid).toBe(false);
  });

  it("earmarked:false leaves liquid defaulting to true as before", () => {
    const raw = basePlan();
    delete (raw.accounts[0] as { liquid?: boolean }).liquid;
    raw.accounts[0]!.earmarked = false;
    const p = normalizePlan(raw);
    expect(p.accounts[0]!.liquid).toBe(true);
  });
});

describe("Account.earmarked — planFromJson validation", () => {
  it("rejects a non-boolean earmarked", () => {
    const p = basePlan();
    (p.accounts[0] as unknown as Record<string, unknown>).earmarked = "yes";
    expect(() => planFromJson(p)).toThrowError(/earmarked must be a boolean/);
  });

  it("rejects earmarked:true with EXPLICIT liquid:true, naming the account", () => {
    const p = basePlan();
    p.accounts[0]!.earmarked = true;
    p.accounts[0]!.liquid = true;
    expect(() => planFromJson(p)).toThrowError(
      new RegExp(`${p.accounts[0]!.name}: earmarked accounts cannot be liquid`),
    );
  });

  it("accepts earmarked:true with ABSENT liquid (implied non-liquid, not an error)", () => {
    const p = basePlan();
    delete (p.accounts[0] as { liquid?: boolean }).liquid;
    p.accounts[0]!.earmarked = true;
    expect(() => planFromJson(p)).not.toThrow();
  });

  it("accepts earmarked:true with EXPLICIT liquid:false", () => {
    const p = basePlan();
    p.accounts[0]!.earmarked = true;
    p.accounts[0]!.liquid = false;
    expect(() => planFromJson(p)).not.toThrow();
  });

  it("accepts earmarked:false with liquid:true", () => {
    const p = basePlan();
    p.accounts[0]!.earmarked = false;
    p.accounts[0]!.liquid = true;
    expect(() => planFromJson(p)).not.toThrow();
  });
});

describe("Contribution.name", () => {
  it("accepts a non-empty name", () => {
    const p = basePlan();
    p.contributions[0]!.name = "match-401k";
    expect(() => planFromJson(p)).not.toThrow();
    expect(planFromJson(p).contributions[0]!.name).toBe("match-401k");
  });

  it("rejects an empty-string name", () => {
    const p = basePlan();
    (p.contributions[0] as unknown as Record<string, unknown>).name = "";
    expect(() => planFromJson(p)).toThrowError(/name must be a non-empty string/);
  });

  it("rejects a non-string name", () => {
    const p = basePlan();
    (p.contributions[0] as unknown as Record<string, unknown>).name = 42;
    expect(() => planFromJson(p)).toThrowError(/name must be a non-empty string/);
  });

  it("leaving name absent on multiple rungs is fine (no false-positive collision)", () => {
    const p = basePlan();
    expect(p.contributions.length).toBeGreaterThan(1);
    expect(() => planFromJson(p)).not.toThrow();
  });

  it("rejects a duplicate name among named rungs, naming the duplicate exactly once", () => {
    const p = basePlan();
    expect(p.contributions.length).toBeGreaterThanOrEqual(3);
    p.contributions[0]!.name = "dup";
    p.contributions[1]!.name = "dup";
    p.contributions[2]!.name = "unique";
    let issues: string[] = [];
    try {
      planFromJson(p);
      throw new Error("expected planFromJson to throw");
    } catch (err) {
      issues = (err as { issues: string[] }).issues;
    }
    const dupIssues = issues.filter((s) => s.includes("dup"));
    expect(dupIssues.length).toBe(1);
  });

  it("allows the same name to be reused as an account name (different namespace)", () => {
    const p = basePlan();
    p.contributions[0]!.name = p.accounts[0]!.name;
    expect(() => planFromJson(p)).not.toThrow();
  });
});

describe("Contribution.hard_end", () => {
  it("accepts a plain finite integer year", () => {
    const p = basePlan();
    p.contributions[0]!.hard_end = 2060;
    expect(() => planFromJson(p)).not.toThrow();
    expect(planFromJson(p).contributions[0]!.hard_end).toBe(2060);
  });

  it("rejects the COAST (-1) sentinel with a named issue", () => {
    const p = basePlan();
    p.contributions[0]!.hard_end = COAST;
    expect(() => planFromJson(p)).toThrowError(/hard_end must be a plain year/);
  });

  it("rejects the RETIREMENT (-2) sentinel with a named issue", () => {
    const p = basePlan();
    p.contributions[0]!.hard_end = RETIREMENT;
    expect(() => planFromJson(p)).toThrowError(/hard_end must be a plain year/);
  });

  it("rejects a non-integer hard_end", () => {
    const p = basePlan();
    (p.contributions[0] as unknown as Record<string, unknown>).hard_end = 2050.5;
    expect(() => planFromJson(p)).toThrowError(/hard_end/);
  });

  it("rejects a non-numeric hard_end", () => {
    const p = basePlan();
    (p.contributions[0] as unknown as Record<string, unknown>).hard_end = "2050";
    expect(() => planFromJson(p)).toThrowError(/hard_end/);
  });
});
