/**
 * 0.6.0 Task 4 — audit_cash_flow. Pins:
 *   - per-year identity: surplus === income - taxes - expenses - contributions
 *     (within $0.01), on every returned year.
 *   - duplicate-name flag: fires (with the observed count) when an income or
 *     expense NAME appears more than once in a year's YearDetail lines; does
 *     NOT fire on a clean plan.
 *   - fund_from shortfall flag: fires (with both rounded figures) when a
 *     fund_from expense's account doesn't cover the full amount that year.
 *   - fromYear/toYear are honored as an inclusive range.
 *   - unknown scenario / no plan loaded -> thrown errors (Session), isError
 *     (MCP).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";
import { dumpPlan } from "../src/planfile.js";
import { Session } from "../src/session.js";
import { syntheticPlan } from "./helpers/synthetic.js";

describe("Session.auditCashFlow — identity", () => {
  it("surplus === income - taxes - expenses - contributions on every returned year", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    const years = session.auditCashFlow();
    expect(years.length).toBeGreaterThan(0);
    for (const y of years) {
      expect(y.surplus, `year ${y.year}`).toBeCloseTo(y.income - y.taxes - y.expenses - y.contributions, 2);
    }
  });
});

describe("Session.auditCashFlow — duplicate-name flag", () => {
  it("fires on a plan with two income lines named 'bonus' active the same year", () => {
    const session = new Session();
    const plan = syntheticPlan();
    plan.incomes.push(
      { name: "bonus", amount: 5000, start: 2026, end: 2030 },
      { name: "bonus", amount: 3000, start: 2026, end: 2030 },
    );
    session.plan = plan;
    const years = session.auditCashFlow(undefined, 2026, 2026);
    const y = years[0]!;
    expect(y.flags.some((f) => f === "duplicate income line 'bonus' appears 2x")).toBe(true);
  });

  it("does not fire on a clean plan (no duplicate income/expense names)", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    const years = session.auditCashFlow();
    const duplicateFlags = years.flatMap((y) => y.flags).filter((f) => f.startsWith("duplicate"));
    expect(duplicateFlags).toEqual([]);
  });
});

describe("Session.auditCashFlow — fund_from shortfall flag", () => {
  it("fires with both rounded figures on an underfunded fund_from expense", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    // synthetic.ts's college529 (balance 12000) funds a $15000/yr expense
    // 2040-2043 — it depletes and falls through by design (see
    // detail.test.ts). Scan the whole window; at least one year must show
    // the shortfall flag with both figures.
    const years = session.auditCashFlow(undefined, 2040, 2043);
    const shortfallFlags = years.flatMap((y) => y.flags).filter((f) => f.startsWith("expense 'college' drew"));
    expect(shortfallFlags.length).toBeGreaterThan(0);
    const match = shortfallFlags[0]!.match(
      /^expense 'college' drew ([\d,]+) from college529 and ([\d,]+) from household cash flow$/,
    );
    expect(match).not.toBeNull();
    const accountFigure = Number(match![1]!.replace(/,/g, ""));
    const cashFlowFigure = Number(match![2]!.replace(/,/g, ""));
    expect(accountFigure).toBeGreaterThanOrEqual(0);
    expect(cashFlowFigure).toBeGreaterThan(0);
  });

  it("does not fire on a fully-covered fund_from year (2040)", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    const years = session.auditCashFlow(undefined, 2040, 2040);
    const shortfallFlags = years[0]!.flags.filter((f) => f.startsWith("expense 'college' drew"));
    expect(shortfallFlags).toEqual([]);
  });
});

describe("Session.auditCashFlow — range args", () => {
  it("honors fromYear/toYear as an inclusive range", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    const years = session.auditCashFlow(undefined, 2030, 2033);
    expect(years.map((y) => y.year)).toEqual([2030, 2031, 2032, 2033]);
  });

  it("returns the full projection horizon when no range is given", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    const all = session.auditCashFlow();
    const proj = session.runProjection();
    expect(all.length).toBe(proj.rows.length);
  });
});

describe("Session.auditCashFlow — error paths", () => {
  it("throws a clear error when no plan is loaded", () => {
    const session = new Session();
    expect(() => session.auditCashFlow()).toThrowError(/no plan loaded/i);
  });

  it("throws a clear error for an unknown scenario name", () => {
    const session = new Session();
    session.plan = syntheticPlan();
    expect(() => session.auditCashFlow("does-not-exist")).toThrowError(/scenario/i);
  });
});

describe("mcp audit_cash_flow", () => {
  let client: Client;
  let planPath: string;
  beforeEach(async () => {
    planPath = join(mkdtempSync(join(tmpdir(), "covefi-")), "p.toml");
    writeFileSync(planPath, dumpPlan(syntheticPlan()));
    const server = createServer(new Session());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
  });
  const call = async (name: string, args: object = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as { text: string }[])[0]!.text);
  };

  it("is registered", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("audit_cash_flow");
  });

  it("returns rounded whole-dollar figures per year", async () => {
    await call("load_plan", { path: planPath });
    const r = await call("audit_cash_flow", { from_year: 2026, to_year: 2027 });
    expect(r.years.length).toBe(2);
    for (const y of r.years) {
      for (const k of ["income", "taxes", "expenses", "contributions", "surplus"]) {
        expect(y[k]).toBe(Math.round(y[k]));
      }
    }
  });

  it("honors from_year/to_year", async () => {
    await call("load_plan", { path: planPath });
    const r = await call("audit_cash_flow", { from_year: 2030, to_year: 2032 });
    expect(r.years.map((y: { year: number }) => y.year)).toEqual([2030, 2031, 2032]);
  });

  it("default window (no range given) is the first 10 projection years plus retirement_year-1..+2, deduped and sorted", async () => {
    await call("load_plan", { path: planPath });
    const fi = await call("fi_status");
    const r = await call("audit_cash_flow");
    const proj = await call("run_projection");
    const years: number[] = r.years.map((y: { year: number }) => y.year);
    // strictly ascending, no duplicates
    for (let i = 1; i < years.length; i++) {
      expect(years[i]).toBeGreaterThan(years[i - 1]!);
    }
    const startYear = proj.rows[0]!.year;
    const firstTen = Array.from({ length: 10 }, (_, i) => startYear + i);
    for (const y of firstTen) {
      expect(years).toContain(y);
    }
    for (let y = fi.retirement_year - 1; y <= fi.retirement_year + 2; y++) {
      expect(years).toContain(y);
    }
  });

  it("unknown scenario -> isError", async () => {
    await call("load_plan", { path: planPath });
    const r = await client.callTool({ name: "audit_cash_flow", arguments: { scenario: "does-not-exist" } });
    expect(r.isError).toBe(true);
  });

  it("no plan loaded -> isError", async () => {
    const r = await client.callTool({ name: "audit_cash_flow", arguments: {} });
    expect(r.isError).toBe(true);
  });
});
