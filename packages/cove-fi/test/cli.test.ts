import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dumpPlan } from "../src/planfile.js";
import { buildProgram } from "../src/cli.js";
import { syntheticPlan } from "./helpers/synthetic.js";

/** Runs buildProgram() against argv, capturing io.out lines, console.error lines,
 * and process.exitCode — then restores process.exitCode so this test run's own
 * exit status is never polluted by a command under test. */
async function runCli(args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number | string | undefined }> {
  const out: string[] = [];
  const errLines: string[] = [];
  const errSpy = vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
    errLines.push(String(msg));
  });
  process.exitCode = undefined;
  const program = buildProgram({ out: (s) => out.push(s) });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "cove-fi", ...args]);
  } catch {
    // exitOverride turns commander-level exits into thrown CommanderError; our own
    // action handlers never throw (they set process.exitCode instead), so a throw
    // here only happens for commander-level parse errors, which is fine to swallow.
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  errSpy.mockRestore();
  return { out, err: errLines, exitCode };
}

function writeTmpPlan(dir: string): string {
  const planPath = join(dir, "plan.toml");
  writeFileSync(planPath, dumpPlan(syntheticPlan()));
  return planPath;
}

describe("cli", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cove-fi-cli-"));
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("run prints a header row containing Year and Net Worth plus one line per year", async () => {
    const planPath = writeTmpPlan(dir);
    const { out, exitCode } = await runCli(["run", planPath]);
    expect(exitCode).toBeUndefined();
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toContain("Year");
    expect(out[0]).toContain("Net Worth");
    // one line per projected year, plus header + footer
    const plan = syntheticPlan();
    const expectedYears = plan.assumptions.end_year - plan.assumptions.start_year + 1;
    // out = [header, ...rows, footer]
    expect(out.length).toBe(expectedYears + 2);
  });

  it("run --json parses to { rows, todays, fi }", async () => {
    const planPath = writeTmpPlan(dir);
    const { out, exitCode } = await runCli(["run", planPath, "--json"]);
    expect(exitCode).toBeUndefined();
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!);
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(Array.isArray(parsed.todays)).toBe(true);
    expect(parsed.fi).toBeDefined();
    expect(typeof parsed.fi.retirement_year).toBe("number");
  });

  it("--json before the subcommand produces JSON identical in shape to --json after it", async () => {
    const planPath = writeTmpPlan(dir);
    const before = await runCli(["--json", "run", planPath]);
    const after = await runCli(["run", planPath, "--json"]);
    expect(before.exitCode).toBeUndefined();
    expect(after.exitCode).toBeUndefined();
    expect(before.out.length).toBe(1);
    const beforeParsed = JSON.parse(before.out[0]!);
    const afterParsed = JSON.parse(after.out[0]!);
    expect(Object.keys(beforeParsed).sort()).toEqual(Object.keys(afterParsed).sort());
    expect(beforeParsed).toEqual(afterParsed);
  });

  it("check on a broken plan file exits nonzero and lists the issue", async () => {
    const brokenPath = join(dir, "broken.toml");
    const broken = dumpPlan(syntheticPlan()).replace(/account = "401k"/, 'account = "401kk"');
    writeFileSync(brokenPath, broken);
    const { err, exitCode } = await runCli(["check", brokenPath]);
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/401kk/);
  });

  it("check on a valid plan file exits zero", async () => {
    const planPath = writeTmpPlan(dir);
    const { exitCode, out } = await runCli(["check", planPath]);
    expect(exitCode).toBeUndefined();
    expect(out.join("\n")).toMatch(/ok/i);
  });

  it("init writes a template file", async () => {
    const outPath = join(dir, "new-plan.toml");
    const { exitCode } = await runCli(["init", outPath]);
    expect(exitCode).toBeUndefined();
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, "utf8")).toContain("[assumptions]");
  });

  it("init twice refuses to overwrite the second time", async () => {
    const outPath = join(dir, "new-plan.toml");
    const first = await runCli(["init", outPath]);
    expect(first.exitCode).toBeUndefined();
    const second = await runCli(["init", outPath]);
    expect(second.exitCode).toBe(1);
    expect(second.err.join("\n")).toMatch(/error:/);
  });

  it("scenario --retirement-year 2045 output differs from run", async () => {
    const planPath = writeTmpPlan(dir);
    const base = await runCli(["run", planPath, "--json"]);
    const scenario = await runCli(["scenario", planPath, "--retirement-year", "2045", "--json"]);
    expect(base.exitCode).toBeUndefined();
    expect(scenario.exitCode).toBeUndefined();
    const baseParsed = JSON.parse(base.out[0]!);
    const scenarioParsed = JSON.parse(scenario.out[0]!);
    expect(scenarioParsed.fi.retirement_year).toBe(2045);
    expect(scenarioParsed.fi.retirement_year).not.toBe(baseParsed.fi.retirement_year);
  });

  it("compare prints a summary table with fi_year, depletion_year, and terminal NW per scenario", async () => {
    const planPath = writeTmpPlan(dir);
    const { out, exitCode } = await runCli([
      "compare",
      planPath,
      "--scenario",
      "base:",
      "--scenario",
      "later:retirement_year=2055",
    ]);
    expect(exitCode).toBeUndefined();
    const text = out.join("\n");
    expect(text).toMatch(/base/);
    expect(text).toMatch(/later/);
    expect(text).toMatch(/Depletion/i);
  });

  it("compare --json parses to the compareScenarios shape", async () => {
    const planPath = writeTmpPlan(dir);
    const { out, exitCode } = await runCli([
      "compare",
      planPath,
      "--scenario",
      "base:",
      "--scenario",
      "later:retirement_year=2055",
      "--json",
    ]);
    expect(exitCode).toBeUndefined();
    const parsed = JSON.parse(out[0]!);
    expect(parsed.series.base).toBeDefined();
    expect(parsed.series.later).toBeDefined();
    expect(parsed.deltas.later).toBeDefined();
  });

  it("compare with an unknown override key exits nonzero and names the bad key, never a raw stack", async () => {
    const planPath = writeTmpPlan(dir);
    const { err, exitCode } = await runCli(["compare", planPath, "--scenario", "x:bogus_key=1"]);
    expect(exitCode).toBe(1);
    const text = err.join("\n");
    expect(text).toMatch(/^error:/);
    expect(text).toMatch(/bogus_key/);
    expect(text).not.toMatch(/at .*\.ts:\d+/);
  });

  it("compare with a non-numeric override value exits nonzero and names the bad value, never a raw stack", async () => {
    const planPath = writeTmpPlan(dir);
    const { err, exitCode } = await runCli(["compare", planPath, "--scenario", "x:ret=abc"]);
    expect(exitCode).toBe(1);
    const text = err.join("\n");
    expect(text).toMatch(/^error:/);
    expect(text).toMatch(/abc/);
    expect(text).not.toMatch(/at .*\.ts:\d+/);
  });

  it("mcp command exists and no longer errors with the stub message", async () => {
    const program = buildProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    expect(mcpCmd).toBeDefined();
    // The real server behavior (tool registration, stdio transport) is
    // covered by test/mcp.test.ts via InMemoryTransport; here we only
    // assert the Task 7 stub is gone.
    expect(mcpCmd!.description()).not.toMatch(/next task/i);
  });

  it("run on a missing plan file prints error: to stderr and exits nonzero, never a raw stack", async () => {
    const { err, exitCode } = await runCli(["run", join(dir, "does-not-exist.toml")]);
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/^error:/);
    expect(err.join("\n")).not.toMatch(/at .*\.ts:\d+/); // no stack trace lines
  });

  it("mc prints a success-rate line and a p50 row", async () => {
    const planPath = writeTmpPlan(dir);
    const { out, exitCode } = await runCli(["mc", planPath, "--trials", "25", "--seed", "7"]);
    expect(exitCode).toBeUndefined();
    const text = out.join("\n");
    expect(text).toMatch(/success/i);
    expect(text).toMatch(/p50/i);
  });

  it("mc --json parses with success_rate/trials/seed/years/percentiles, full resolution (not thinned)", async () => {
    const planPath = writeTmpPlan(dir);
    const { out, exitCode } = await runCli(["mc", planPath, "--trials", "25", "--seed", "7", "--json"]);
    expect(exitCode).toBeUndefined();
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!);
    expect(typeof parsed.success_rate).toBe("number");
    expect(parsed.trials).toBe(25);
    expect(parsed.seed).toBe(7);
    expect(Array.isArray(parsed.years)).toBe(true);
    expect(Array.isArray(parsed.percentiles.p50)).toBe(true);
    // Full-resolution, untruncated — matches `run --json`/`compare --json`
    // precedent. Thinning to <=30 rows is an MCP-only context-window concern.
    const plan = syntheticPlan();
    const expectedYears = plan.assumptions.end_year - plan.assumptions.start_year + 1;
    expect(parsed.years.length).toBe(expectedYears);
    expect(parsed.percentiles.p50.length).toBe(expectedYears);
  });

  it("mc --trials 0 exits nonzero without calling the lib", async () => {
    const planPath = writeTmpPlan(dir);
    const { err, exitCode } = await runCli(["mc", planPath, "--trials", "0"]);
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/^error:/);
  });

  it("mc --trials -5 exits nonzero", async () => {
    const planPath = writeTmpPlan(dir);
    const { err, exitCode } = await runCli(["mc", planPath, "--trials", "-5"]);
    expect(exitCode).toBe(1);
    expect(err.join("\n")).toMatch(/^error:/);
  });
});
