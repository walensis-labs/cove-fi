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

describe("income_gross_from_net", () => {
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

  it("computes the closed form with no plan loaded", async () => {
    const r = await call("income_gross_from_net", {
      net_annual: 100_000,
      deferrals_annual: 10_000,
      income_tax: 0.3,
      local_tax: 0.01,
    });
    expect(r.computed_gross).toBe(Math.round(100_000 / 0.69 + 10_000)); // 154,928
    expect(r.ordinary_rate_used).toBeCloseTo(0.31, 10);
    expect(r.formula).toContain("gross = net / (1 - (income_tax + local_tax)) + deferrals");
    expect(r.reconciliation).toBeUndefined();
  });

  it("defaults deferrals to 0", async () => {
    const r = await call("income_gross_from_net", {
      net_annual: 69_000,
      income_tax: 0.3,
      local_tax: 0.01,
    });
    expect(r.computed_gross).toBe(100_000);
    expect(r.deferrals_annual).toBe(0);
  });

  it("reconciles an agreeing stated gross", async () => {
    const r = await call("income_gross_from_net", {
      net_annual: 100_000,
      deferrals_annual: 10_000,
      income_tax: 0.3,
      local_tax: 0.01,
      stated_gross: 155_000,
    });
    expect(r.reconciliation.agrees).toBe(true);
    expect(Math.abs(r.reconciliation.delta)).toBeLessThan(1_600); // within 1%
  });

  it("flags a disagreeing stated gross with a signed delta", async () => {
    const r = await call("income_gross_from_net", {
      net_annual: 100_000,
      deferrals_annual: 10_000,
      income_tax: 0.3,
      local_tax: 0.01,
      stated_gross: 140_000,
    });
    expect(r.reconciliation.agrees).toBe(false);
    expect(r.reconciliation.delta).toBeGreaterThan(0); // computed exceeds stated
  });

  it("uses the loaded plan's rates when they are omitted", async () => {
    await call("load_plan", { path: planPath }); // synthetic: income_tax .30 local .01
    const r = await call("income_gross_from_net", { net_annual: 69_000 });
    expect(r.computed_gross).toBe(100_000);
  });

  it("requires rates when no plan is loaded", async () => {
    const res = await client.callTool({ name: "income_gross_from_net", arguments: { net_annual: 50_000 } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/income_tax and local_tax are required/);
  });

  it("rejects an ordinary rate >= 1", async () => {
    const res = await client.callTool({
      name: "income_gross_from_net",
      arguments: { net_annual: 50_000, income_tax: 0.9, local_tax: 0.15 },
    });
    expect(res.isError).toBe(true);
  });

  it("is propose-only: projections are unchanged after calling it", async () => {
    await call("load_plan", { path: planPath });
    const before = await call("run_projection", {});
    await call("income_gross_from_net", { net_annual: 69_000 });
    expect(await call("run_projection", {})).toEqual(before);
  });

  it("the onboard prompt tells the assistant to convert take-home first", async () => {
    const p = await client.getPrompt({ name: "onboard" });
    const text = JSON.stringify(p).toLowerCase();
    expect(text).toContain("take-home");
    expect(text).toContain("income_gross_from_net");
    // require confirmation of the full gross/take-home chain before the
    // figure enters the plan — never silently assumed.
    expect(text).toContain("before you call `create_plan`".toLowerCase());
  });
});
