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
  it("exposes all seven tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_scenarios",
      "fi_status",
      "get_assumptions",
      "load_plan",
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
});
