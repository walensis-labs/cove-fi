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

describe("per-class growth + gated cash tax", () => {
  const probe = (accs: object[], assum: object = {}) => planFromJson({
    birth_year: 1990, accounts: accs, incomes: [], social_security: [],
    expenses: [], contributions: [], house: null,
    assumptions: { start_year: 2026, end_year: 2028, first_year_fraction: 1,
      retirement_year: 2099, dividend_rate: 0, inflation: 0.03, ret: 0.07,
      income_tax: 0.30, local_tax: 0.01, cap_gains_tax: 0.15,
      coast_multiple: 4, fi_multiple: 25, ...assum } });
  it("class cash rate compounds and is taxed as ordinary income", () => {
    const rows = run(probe([{ name: "c", tax: "cash", balance: 10_000 }],
                           { class_returns: { cash: 0.03 } }));
    // year1: tax = 10000*0.03*0.31 = 93; balance grows to 10300
    expect(rows[0]!.taxes).toBeCloseTo(93, 6);
    expect(rows[0]!.net_worth).toBeCloseTo(10_300, 6);
  });
  it("legacy cash (growth:0, no new fields) stays untaxed and flat", () => {
    const rows = run(probe([{ name: "c", tax: "cash", balance: 10_000, growth: 0 }]));
    expect(rows[0]!.taxes).toBe(0);
    expect(rows[0]!.net_worth).toBe(10_000);
  });
  it("taxable grows at FULL resolved rate; dividend slice taxed only", () => {
    const rows = run(probe([{ name: "b", tax: "taxable", balance: 10_000, basis: 10_000, ret: 0.05 }],
                           { dividend_rate: 0.02 }));
    expect(rows[0]!.net_worth).toBeCloseTo(10_500, 6);           // full 5%
    expect(rows[0]!.taxes).toBeCloseTo(10_000 * 0.02 * 0.15, 6); // slice only
  });
});
