#!/usr/bin/env node
/**
 * cove-fi CLI — commander wiring around the `Session` layer (src/session.ts).
 *
 * `buildProgram(io?)` builds and returns the commander `Command` without
 * running it: all normal (stdout) output goes through `io.out` (default
 * `console.log`), so tests can capture it in-process via
 * `buildProgram({ out: ... }).parseAsync([...])` instead of spawning a
 * subprocess. Errors go to stderr as `error: <message>` (never a raw
 * stack) with `process.exitCode = 1`; `check` additionally lists a broken
 * plan file's issues.
 *
 * `main()` — the real entry point — only runs when this file is executed
 * as a script (the `import.meta.url` guard below), so importing
 * `buildProgram` for tests has no side effects.
 */
import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import type { YearRow } from "./engine.js";
import { initTemplate } from "./planfile.js";
import { type FiStatus, type ScenarioOverrides, Session } from "./session.js";

export interface Io {
  out: (s: string) => void;
}

const defaultIo: Io = { out: (s) => console.log(s) };

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function fail(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  process.exitCode = 1;
}

function fmtYear(v: number | null): string {
  return v === null ? "—" : String(v);
}

function fmtDelta(v: number): string {
  const s = nf.format(Math.abs(v));
  return v < 0 ? `-${s}` : `+${s}`;
}

// ---------------------------------------------------------------------
// run/scenario projection table
// ---------------------------------------------------------------------

const PROJECTION_COLUMNS: Array<{ header: string; key: keyof YearRow }> = [
  { header: "Year", key: "year" },
  { header: "Net Worth", key: "net_worth" },
  { header: "Liquid NW", key: "liquid_net_worth" },
  { header: "Income", key: "income" },
  { header: "Expenses", key: "expenses" },
  { header: "Taxes", key: "taxes" },
  { header: "Contrib", key: "contributions" },
  { header: "Withdrawals", key: "withdrawals" },
];

function formatCell(key: keyof YearRow, value: number): string {
  return key === "year" ? String(value) : nf.format(value);
}

function renderProjectionTable(rows: YearRow[]): string[] {
  const cellRows = rows.map((r) => PROJECTION_COLUMNS.map((c) => formatCell(c.key, r[c.key])));
  const widths = PROJECTION_COLUMNS.map((c, i) => Math.max(c.header.length, ...cellRows.map((row) => row[i]!.length)));
  const headerLine = PROJECTION_COLUMNS.map((c, i) => c.header.padStart(widths[i]!)).join("  ");
  const rowLines = cellRows.map((row) => row.map((v, i) => v.padStart(widths[i]!)).join("  "));
  return [headerLine, ...rowLines];
}

function renderFooter(fi: FiStatus): string {
  return `FI year: ${fmtYear(fi.fi_year)} | Coast year: ${fmtYear(fi.coast_year)} | Depletion year: ${fmtYear(fi.depletion_year)}`;
}

function printProjection(io: Io, session: Session, scenario: string | undefined, json: boolean): void {
  const { rows, todays } = session.runProjection(scenario);
  const fi = session.fiStatus(scenario);
  if (json) {
    io.out(JSON.stringify({ rows, todays, fi }));
    return;
  }
  for (const line of renderProjectionTable(rows)) io.out(line);
  io.out(renderFooter(fi));
}

// ---------------------------------------------------------------------
// compare summary table
// ---------------------------------------------------------------------

interface ScenarioSpec {
  name: string;
  overrides: ScenarioOverrides;
}

const SCENARIO_OVERRIDE_KEYS = [
  "retirement_year",
  "inflation",
  "ret",
  "savings_rate_multiplier",
  "ss_haircut",
  "ss_claim_year",
] as const;
type ScenarioOverrideKey = (typeof SCENARIO_OVERRIDE_KEYS)[number];

function isScenarioOverrideKey(k: string): k is ScenarioOverrideKey {
  return (SCENARIO_OVERRIDE_KEYS as readonly string[]).includes(k);
}

/** Parses one `--scenario name:key=val,key=val,...` flag value. The part after the first `:` may be empty (a bare baseline with no overrides). */
function parseScenarioArg(spec: string): ScenarioSpec {
  const colonIdx = spec.indexOf(":");
  const name = colonIdx === -1 ? spec : spec.slice(0, colonIdx);
  if (!name) throw new Error(`invalid --scenario "${spec}" (expected name:key=val,...)`);
  const rest = colonIdx === -1 ? "" : spec.slice(colonIdx + 1);
  const overrides: ScenarioOverrides = {};
  if (rest.length > 0) {
    for (const pair of rest.split(",")) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) throw new Error(`invalid --scenario override "${pair}" (expected key=val)`);
      const key = pair.slice(0, eqIdx).trim();
      const rawVal = pair.slice(eqIdx + 1).trim();
      if (!isScenarioOverrideKey(key)) {
        throw new Error(`unknown scenario override key "${key}" (expected one of ${SCENARIO_OVERRIDE_KEYS.join(", ")})`);
      }
      const val = Number(rawVal);
      if (Number.isNaN(val)) throw new Error(`invalid scenario override value "${rawVal}" for "${key}"`);
      overrides[key] = val;
    }
  }
  return { name, overrides };
}

function collectScenario(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface CompareEntry {
  name: string;
  status: FiStatus;
  delta: { terminal_delta: number; fi_year_delta: number | null };
}

function renderCompareTable(entries: CompareEntry[]): string[] {
  const headers = ["Name", "FI Year", "Depletion Year", "Terminal NW", "Δ Terminal NW"];
  const cellRows = entries.map((e) => [
    e.name,
    fmtYear(e.status.fi_year),
    fmtYear(e.status.depletion_year),
    nf.format(e.status.terminal_net_worth),
    fmtDelta(e.delta.terminal_delta),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cellRows.map((row) => row[i]!.length)));
  const headerLine = headers.map((h, i) => (i === 0 ? h.padEnd(widths[i]!) : h.padStart(widths[i]!))).join("  ");
  const rowLines = cellRows.map((row) => row.map((v, i) => (i === 0 ? v.padEnd(widths[i]!) : v.padStart(widths[i]!))).join("  "));
  return [headerLine, ...rowLines];
}

// ---------------------------------------------------------------------
// program
// ---------------------------------------------------------------------

/** `--json` is declared both on the root program (so `cove-fi --json run plan.toml`
 * parses) and on each data-output subcommand (so `cove-fi run plan.toml --json`
 * keeps working) — `Command.optsWithGlobals()` merges local + ancestor option
 * values, local wins when both are set, so either placement produces the
 * same result. */
function resolveJson(opts: { json?: boolean }, cmd: Command): boolean {
  return !!(opts.json ?? cmd.optsWithGlobals().json);
}

export function buildProgram(io: Io = defaultIo): Command {
  const program = new Command();
  program
    .name("cove-fi")
    .description("Cove FI — retirement/FI projection engine")
    .version("0.1.0")
    .option("--json", "output JSON instead of a table (run/scenario/compare)");

  program
    .command("init")
    .description("Write a starter plan file")
    .argument("[path]", "output path", "my-plan.toml")
    .action((path: string) => {
      try {
        if (existsSync(path)) {
          throw new Error(`refusing to overwrite existing file: ${path}`);
        }
        writeFileSync(path, initTemplate());
        io.out(`Wrote plan template to ${path}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("run")
    .description("Run a plan and print its projection")
    .argument("<plan>", "path to plan TOML file")
    .option("--json", "output JSON instead of a table")
    .action((planPath: string, opts: { json?: boolean }, cmd: Command) => {
      try {
        const session = new Session();
        session.loadPlanFile(planPath);
        printProjection(io, session, undefined, resolveJson(opts, cmd));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("scenario")
    .description("Run a plan with scenario overrides applied")
    .argument("<plan>", "path to plan TOML file")
    .option("--retirement-year <n>", "override retirement year", (v) => Number(v))
    .option("--ret <x>", "override nominal investment return", (v) => Number(v))
    .option("--inflation <x>", "override inflation", (v) => Number(v))
    .option("--savings-rate-multiplier <x>", "scale every contribution rung", (v) => Number(v))
    .option("--ss-haircut <x>", "override Social Security haircut", (v) => Number(v))
    .option("--ss-claim-year <n>", "override Social Security claim year", (v) => Number(v))
    .option("--json", "output JSON instead of a table")
    .action(
      (
        planPath: string,
        opts: {
          retirementYear?: number;
          ret?: number;
          inflation?: number;
          savingsRateMultiplier?: number;
          ssHaircut?: number;
          ssClaimYear?: number;
          json?: boolean;
        },
        cmd: Command,
      ) => {
        try {
          const session = new Session();
          session.loadPlanFile(planPath);
          const overrides: ScenarioOverrides = {};
          if (opts.retirementYear !== undefined) overrides.retirement_year = opts.retirementYear;
          if (opts.ret !== undefined) overrides.ret = opts.ret;
          if (opts.inflation !== undefined) overrides.inflation = opts.inflation;
          if (opts.savingsRateMultiplier !== undefined) overrides.savings_rate_multiplier = opts.savingsRateMultiplier;
          if (opts.ssHaircut !== undefined) overrides.ss_haircut = opts.ssHaircut;
          if (opts.ssClaimYear !== undefined) overrides.ss_claim_year = opts.ssClaimYear;
          session.defineScenario("cli", overrides);
          printProjection(io, session, "cli", resolveJson(opts, cmd));
        } catch (err) {
          fail(err);
        }
      },
    );

  program
    .command("compare")
    .description("Compare named scenarios against a baseline")
    .argument("<plan>", "path to plan TOML file")
    .option("--scenario <spec>", "name:key=val,key=val,... (repeatable; first is the baseline)", collectScenario, [] as string[])
    .option("--json", "output the raw compareScenarios JSON")
    .action((planPath: string, opts: { scenario: string[]; json?: boolean }, cmd: Command) => {
      try {
        if (!opts.scenario || opts.scenario.length === 0) {
          throw new Error("compare requires at least one --scenario name:key=val,...");
        }
        const session = new Session();
        session.loadPlanFile(planPath);
        const specs = opts.scenario.map(parseScenarioArg);
        for (const s of specs) session.defineScenario(s.name, s.overrides);
        const names = specs.map((s) => s.name);
        const cmp = session.compareScenarios(names);
        if (resolveJson(opts, cmd)) {
          io.out(JSON.stringify(cmp));
          return;
        }
        const entries: CompareEntry[] = names.map((name) => ({
          name,
          status: session.fiStatus(name),
          delta: cmp.deltas[name]!,
        }));
        for (const line of renderCompareTable(entries)) io.out(line);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("check")
    .description("Validate a plan file without running it")
    .argument("<plan>", "path to plan TOML file")
    .action((planPath: string) => {
      try {
        const session = new Session();
        session.loadPlanFile(planPath);
        io.out(`plan OK: ${planPath}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("mcp")
    .description("Start the MCP stdio server")
    .action(() => {
      console.error("mcp server arrives in the next task");
      process.exitCode = 1;
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
