import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/engine.js";
import { resolveRet } from "../src/model.js";
import { planFromJson } from "../src/planjson.js";

const golden = (f: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "golden", f), "utf8"));

describe("golden backward compatibility", () => {
  it("plans without new fields are byte-identical to 0.3.0", () => {
    const rows = run(planFromJson(golden("golden-plan.json")));
    expect(rows).toEqual(golden("golden-rows.json"));  // exact, not toBeCloseTo
  });
});

describe("resolveRet precedence", () => {
  const a = { ret: 0.07, class_returns: { cash: 0.035 } } as never;
  it("account override wins", () =>
    expect(resolveRet({ name: "x", tax: "cash", balance: 0, ret: 0.05 } as never, a)).toBe(0.05));
  it("class default second", () =>
    expect(resolveRet({ name: "x", tax: "cash", balance: 0 } as never, a)).toBe(0.035));
  it("global fallback last", () =>
    expect(resolveRet({ name: "x", tax: "taxable", balance: 0 } as never, a)).toBe(0.07));
});

describe("validation", () => {
  const base = () => golden("golden-plan.json");
  it("rejects out-of-range rates listing every offender", () => {
    const p = base();
    p.accounts[0].ret = 0.9; p.accounts[1].ret = -0.9;
    expect(() => planFromJson(p)).toThrowError(new RegExp(`${p.accounts[0].name}[\\s\\S]*${p.accounts[1].name}`));
  });
  it("rejects unknown class_returns keys", () => {
    const p = base(); p.assumptions.class_returns = { stonks: 0.1 };
    expect(() => planFromJson(p)).toThrowError(/stonks/);
  });
  it("accepts and round-trips valid fields through TOML", async () => {
    const { dumpPlan, loadPlan } = await import("../src/planfile.js");
    const p = base(); p.assumptions.class_returns = { cash: 0.035 }; p.accounts[0].ret = 0.05;
    const back = loadPlan(dumpPlan(planFromJson(p)));
    expect(back.assumptions.class_returns).toEqual({ cash: 0.035 });
    expect(back.accounts[0].ret).toBe(0.05);
  });
});
