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

describe("run_scenario strict override validation", () => {
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

  it("typo'd override key errors instead of silently returning base results", async () => {
    await call("load_plan", { path: planPath });
    const r = await client.callTool({
      name: "run_scenario",
      arguments: { name: "typo", overrides: { contributions_end: 2039 } },
    });
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text).toContain("contributions_end");
    expect(text).toContain("retirement_year"); // supported set present
    expect(text).toContain("contributions"); // Task 5: contributions object joins the supported set
  });

  it("unknown key inside overrides.contributions errors", async () => {
    await call("load_plan", { path: planPath });
    const r = await client.callTool({
      name: "run_scenario",
      arguments: { name: "bad-contrib", overrides: { contributions: { end: 2039, bogus: true } } },
    });
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text).toContain("bogus");
  });

  it("well-formed overrides.contributions (end/keep/scale) is accepted", async () => {
    await call("load_plan", { path: planPath });
    const r = await call("run_scenario", {
      name: "good-contrib",
      overrides: { contributions: { end: 2039, keep: [], scale: 0.5 } },
    });
    expect(r).toHaveProperty("fi");
  });

  it("unknown nested field in extra_expenses errors", async () => {
    await call("load_plan", { path: planPath });
    const r = await client.callTool({
      name: "run_scenario",
      arguments: {
        name: "x",
        overrides: {
          extra_expenses: [{ name: "e", amount: 1000, start: 2030, end: 2031, growht_over_inflation: 0.02 }],
        },
      },
    });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toContain("growht_over_inflation");
  });

  it("valid scenario identical to base is still legitimate", async () => {
    await call("load_plan", { path: planPath });
    const r = await call("run_scenario", { name: "same", overrides: { ss_haircut: 1.0 } });
    expect(r).toHaveProperty("fi");
  });
});
