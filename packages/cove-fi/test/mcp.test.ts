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

describe("mcp server", () => {
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
  it("exposes all eight tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_scenarios",
      "fi_status",
      "get_assumptions",
      "load_plan",
      "monte_carlo",
      "run_projection",
      "run_scenario",
      "set_assumption",
    ]);
  });
  it("load -> project -> fi_status flow", async () => {
    await call("load_plan", { path: planPath });
    const proj = await call("run_projection");
    expect(proj.rows.length).toBeLessThanOrEqual(30);
    const fi = await call("fi_status");
    expect(fi).toHaveProperty("retirement_year");
  });
  it("scenario define + compare", async () => {
    await call("load_plan", { path: planPath });
    await call("run_scenario", { name: "late", overrides: { retirement_year: 2055 } });
    const cmp = await call("compare_scenarios", { names: ["late"] });
    expect(cmp.deltas.late).toHaveProperty("terminal_delta");
  });
  it("tool errors are structured, not crashes", async () => {
    const r = await client.callTool({ name: "load_plan", arguments: { path: "/nope.toml" } });
    expect(r.isError).toBe(true);
  });
  it("projection before load_plan -> structured error", async () => {
    const r = await client.callTool({ name: "run_projection", arguments: {} });
    expect(r.isError).toBe(true);
  });
  it("set_assumption mutates the plan and changes the projection", async () => {
    await call("load_plan", { path: planPath });
    const before = await call("run_projection");
    await call("set_assumption", { key: "ret", value: 0.2 });
    const after = await call("run_projection");
    expect(after.rows.at(-1)!.net_worth).not.toBe(before.rows.at(-1)!.net_worth);
  });
  it("set_assumption rejects an unknown key with a structured error", async () => {
    await call("load_plan", { path: planPath });
    const r = await client.callTool({ name: "set_assumption", arguments: { key: "bogus_key", value: 1 } });
    expect(r.isError).toBe(true);
  });
  it("get_assumptions returns the loaded plan's assumptions, including a value changed via set_assumption", async () => {
    await call("load_plan", { path: planPath });
    await call("set_assumption", { key: "ret", value: 0.42 });
    const a = await call("get_assumptions");
    expect(a.ret).toBe(0.42);
    expect(a).toHaveProperty("retirement_year");
    expect(a).toHaveProperty("inflation");
  });
  it("run_scenario rejects an extra_expenses entry missing `amount` as a structured error, not a NaN-riddled projection", async () => {
    await call("load_plan", { path: planPath });
    const r = await client.callTool({
      name: "run_scenario",
      arguments: {
        name: "broken",
        overrides: { extra_expenses: [{ name: "mystery", start: 2030, end: 2035 }] },
      },
    });
    expect(r.isError).toBe(true);
  });
  it("run_scenario with a well-formed extra expense changes the projection and contains no nulls", async () => {
    await call("load_plan", { path: planPath });
    const base = await call("run_projection");
    await call("run_scenario", {
      name: "extra-spend",
      overrides: {
        extra_expenses: [{ name: "boat", amount: 20000, start: 2030, end: 2040 }],
      },
    });
    const proj = await call("run_projection", { scenario: "extra-spend" });
    // Both projections eventually deplete liquid net worth to the same
    // illiquid-only floor, so the *final* row can coincide even though the
    // expense clearly changed the trajectory — compare a row inside the
    // 2030-2040 expense window instead (kept by thinning's "every 5th"
    // sampling) rather than relying on the last row alone.
    const baseMid = base.rows.find((r: { year: number }) => r.year === 2031);
    const projMid = proj.rows.find((r: { year: number }) => r.year === 2031);
    expect(baseMid).toBeDefined();
    expect(projMid).toBeDefined();
    expect(projMid.net_worth).not.toBe(baseMid.net_worth);
    for (const row of [...proj.rows, ...proj.todays]) {
      for (const v of Object.values(row)) {
        expect(v).not.toBeNull();
        expect(Number.isNaN(v as number)).toBe(false);
      }
    }
  });
  it("compare_scenarios series is thinned to <=30 rows per scenario", async () => {
    await call("load_plan", { path: planPath });
    await call("run_scenario", { name: "late", overrides: { retirement_year: 2055 } });
    await call("run_scenario", { name: "early", overrides: { retirement_year: 2045 } });
    const cmp = await call("compare_scenarios", { names: ["late", "early"] });
    expect(cmp.series.late.length).toBeLessThanOrEqual(30);
    expect(cmp.series.early.length).toBeLessThanOrEqual(30);
    expect(cmp.years.length).toBe(cmp.series.late.length);
  });

  it("monte_carlo returns a parseable, bounded payload", async () => {
    await call("load_plan", { path: planPath });
    const mc = await call("monte_carlo", { trials: 50, seed: 7 });
    expect(mc.success_rate).toBeGreaterThanOrEqual(0);
    expect(mc.success_rate).toBeLessThanOrEqual(1);
    expect(mc.trials).toBe(50);
    expect(mc.seed).toBe(7);
    expect(mc.percentiles.p50.length).toBeLessThanOrEqual(30);
    expect(mc.years.length).toBe(mc.percentiles.p50.length);
  });

  it("monte_carlo before load_plan -> structured error", async () => {
    const r = await client.callTool({ name: "monte_carlo", arguments: {} });
    expect(r.isError).toBe(true);
  });

  it("monte_carlo with an unknown scenario -> structured error", async () => {
    await call("load_plan", { path: planPath });
    const r = await client.callTool({ name: "monte_carlo", arguments: { scenario: "does-not-exist" } });
    expect(r.isError).toBe(true);
  });
});
