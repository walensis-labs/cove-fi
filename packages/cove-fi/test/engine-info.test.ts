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

describe("get_engine_info", () => {
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

  it("answers before any plan is loaded", async () => {
    const info = await call("get_engine_info", {});
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(info.metrics_version).toBe("1");
  });
  it("advertises the live override key list", async () => {
    const info = await call("get_engine_info", {});
    expect(info.scenario_override_keys).toContain("contributions");
    expect(info.scenario_override_keys).toContain("class_returns");
  });
  it("capabilities include every registered tool", async () => {
    const { tools } = await client.listTools();
    const info = await call("get_engine_info", {});
    for (const t of tools) expect(info.capabilities).toContain(t.name);
  });
  it("defines the metrics that changed meaning historically", async () => {
    const info = await call("get_engine_info", {});
    expect(info.metric_definitions.coast_year).toMatch(/no further contributions/);
  });
  it("fi_status and run_projection carry metrics_version", async () => {
    await call("load_plan", { path: planPath });
    expect((await call("fi_status", {})).metrics_version).toBe("1");
    expect((await call("run_projection", {})).metrics_version).toBe("1");
  });
});
