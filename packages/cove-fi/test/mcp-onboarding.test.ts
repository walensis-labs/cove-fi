import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/mcp/server.js";
import { Session } from "../src/session.js";
import { syntheticPlan } from "./helpers/synthetic.js";

describe("mcp onboarding/plan-building tools", () => {
  let client: Client;
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "covefi-mcp-onboarding-"));
    vi.stubEnv("COVE_FI_PLANS", dir);
    const server = createServer(new Session());
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
  });
  afterEach(() => vi.unstubAllEnvs());

  const call = async (name: string, args: object = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as { text: string }[])[0]!.text);
  };

  it("tool list contains the four new plan-building tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_plans");
    expect(names).toContain("create_plan");
    expect(names).toContain("update_plan");
    expect(names).toContain("save_plan");
  });

  it("empty-store list_plans returns the exact hint", async () => {
    const r = await call("list_plans");
    expect(r.plans).toEqual([]);
    expect(r.hint).toBe("No plans found. Use the onboard prompt, create_plan, or seed_from_ynab.");
  });

  it("create_plan returns a plan summary payload", async () => {
    const plan = syntheticPlan();
    const summary = await call("create_plan", { plan });
    expect(summary.accounts).toBe(plan.accounts.length);
    expect(summary.incomes).toBe(plan.incomes.length);
    expect(summary.expenses).toBe(plan.expenses.length);
    expect(summary.contributions).toBe(plan.contributions.length);
    expect(summary.birth_year).toBe(plan.birth_year);
    expect(summary.retirement_year).toBe(plan.assumptions.retirement_year);
  });

  it("create_plan surfaces validation issues in the error text", async () => {
    const r = await client.callTool({ name: "create_plan", arguments: { plan: { nonsense: true } } });
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/birth_year/i);
  });

  it("update_plan add+set path", async () => {
    const plan = syntheticPlan();
    await call("create_plan", { plan });
    const summary = await call("update_plan", {
      add: { accounts: [{ name: "extra-savings", tax: "cash", balance: 500 }] },
      set: { birth_year: 1985 },
    });
    expect(summary.accounts).toBe(plan.accounts.length + 1);
    expect(summary.birth_year).toBe(1985);
  });

  it("update_plan with neither add nor set is a structured error", async () => {
    const plan = syntheticPlan();
    await call("create_plan", { plan });
    const r = await client.callTool({ name: "update_plan", arguments: {} });
    expect(r.isError).toBe(true);
  });

  it("save -> list finds it -> load_plan by bare name -> run_projection works (full loop)", async () => {
    const plan = syntheticPlan();
    await call("create_plan", { plan });
    const saved = await call("save_plan", { name: "onboard-loop" });
    expect(saved.path).toContain("onboard-loop.toml");

    const listed = await call("list_plans");
    expect(listed.plans.map((p: { name: string }) => p.name)).toContain("onboard-loop");

    await call("load_plan", { path: "onboard-loop" });
    const proj = await call("run_projection");
    expect(proj.rows.length).toBeGreaterThan(0);
  });

  it("save_plan duplicate without overwrite -> isError", async () => {
    const plan = syntheticPlan();
    await call("create_plan", { plan });
    await call("save_plan", { name: "dup-plan" });
    await call("create_plan", { plan });
    const r = await client.callTool({ name: "save_plan", arguments: { name: "dup-plan" } });
    expect(r.isError).toBe(true);
  });

  it("listPrompts contains the onboard prompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("onboard");
  });

  it("getPrompt(onboard) covers the guided-onboarding load-bearing instructions", async () => {
    const result = await client.getPrompt({ name: "onboard" });
    const text = result.messages.map((m) => (m.content as { text: string }).text).join("\n");
    const lower = text.toLowerCase();
    expect(lower).toContain("list_plans");
    expect(lower).toContain("ynab");
    expect(lower).toContain("budgeting tools you may have connected");
    expect(lower).toContain("create_plan");
    expect(lower).toContain("update_plan");
    expect(lower).toContain("never invent numbers");
    expect(lower).toContain("save_plan");
    expect(lower).toContain("monte_carlo");
    expect(lower).toContain("get_assumptions");
  });
});
