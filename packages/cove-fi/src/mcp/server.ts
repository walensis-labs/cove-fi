/**
 * Client-agnostic stdio MCP server — thin wrapper over `Session` (session.ts).
 *
 * Every tool handler below does exactly three things: validate/coerce
 * input via zod, call one `Session` method, and shape the result for a
 * small context window (dollar amounts rounded to whole dollars, and
 * `run_projection`'s year rows thinned). NO business logic lives here —
 * that's all in `Session`/`engine.ts`. Nothing writes to stdout: stdout is
 * the MCP protocol channel in stdio mode, so any diagnostic output must go
 * to stderr (`console.error`), never `console.log`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type YearRow } from "../engine.js";
import { type Assumptions, DEFAULT_ASSUMPTIONS } from "../model.js";
import { type FiStatus, type ScenarioOverrides, Session } from "../session.js";

// ---------------------------------------------------------------------
// result helpers
// ---------------------------------------------------------------------

function toolOk(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function toolError(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

/** Wraps a handler body so any thrown Session/engine error becomes a
 * structured tool error instead of crashing the server. */
function guarded(fn: () => unknown): CallToolResult {
  try {
    return toolOk(fn());
  } catch (err) {
    return toolError(err);
  }
}

// ---------------------------------------------------------------------
// dollar rounding — every dollar field in every tool payload is rounded
// to whole dollars; rates/years pass through untouched.
// ---------------------------------------------------------------------

const DOLLAR_ROW_KEYS = [
  "net_worth",
  "liquid_net_worth",
  "income",
  "expenses",
  "taxes",
  "withdrawals",
  "contributions",
] as const satisfies readonly (keyof YearRow)[];

function roundRow(row: YearRow): YearRow {
  const out = { ...row };
  for (const k of DOLLAR_ROW_KEYS) out[k] = Math.round(row[k]);
  return out;
}

function roundFiStatus(fi: FiStatus): FiStatus {
  return {
    ...fi,
    terminal_net_worth: Math.round(fi.terminal_net_worth),
    terminal_net_worth_todays: Math.round(fi.terminal_net_worth_todays),
  };
}

// ---------------------------------------------------------------------
// row thinning (run_projection only — full tables stay a CLI/--json
// concern). Keeps: first 5 years, every 5th year thereafter, retirement
// year +/-2, and the final year. Guarantees <=30 rows for a 66-year plan.
// ---------------------------------------------------------------------

function thinRows(rows: YearRow[], retirementYear: number): YearRow[] {
  const n = rows.length;
  if (n === 0) return rows;
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(5, n); i++) keep.add(i);
  for (let i = 5; i < n; i += 5) keep.add(i);
  for (let i = 0; i < n; i++) {
    if (Math.abs(rows[i]!.year - retirementYear) <= 2) keep.add(i);
  }
  keep.add(n - 1);
  return [...keep].sort((a, b) => a - b).map((i) => rows[i]!);
}

// ---------------------------------------------------------------------
// zod shapes
// ---------------------------------------------------------------------

const ASSUMPTIONS_KEYS = Object.keys(DEFAULT_ASSUMPTIONS) as [keyof Assumptions, ...(keyof Assumptions)[]];

const scenarioOverridesShape = {
  retirement_year: z.number().optional(),
  inflation: z.number().optional(),
  ret: z.number().optional(),
  savings_rate_multiplier: z.number().optional(),
  ss_haircut: z.number().optional(),
  ss_claim_year: z.number().optional(),
  extra_expenses: z.array(z.record(z.unknown())).optional(),
  extra_incomes: z.array(z.record(z.unknown())).optional(),
};

// ---------------------------------------------------------------------
// server
// ---------------------------------------------------------------------

export function createServer(session: Session): McpServer {
  const server = new McpServer({ name: "cove-fi", version: "0.1.0" });

  server.registerTool(
    "load_plan",
    { description: "Load a plan TOML file into the session.", inputSchema: { path: z.string() } },
    ({ path }) =>
      guarded(() => {
        session.loadPlanFile(path);
        return { path, loaded: true };
      }),
  );

  server.registerTool(
    "get_assumptions",
    { description: "Return the loaded plan's assumptions.", inputSchema: {} },
    () =>
      guarded(() => {
        if (!session.plan) throw new Error("no plan loaded — call load_plan first");
        return session.plan.assumptions;
      }),
  );

  server.registerTool(
    "set_assumption",
    {
      description: "Mutate one assumption on the loaded plan.",
      inputSchema: { key: z.enum(ASSUMPTIONS_KEYS), value: z.number() },
    },
    ({ key, value }) =>
      guarded(() => {
        if (!session.plan) throw new Error("no plan loaded — call load_plan first");
        session.plan.assumptions[key] = value;
        return session.plan.assumptions;
      }),
  );

  server.registerTool(
    "run_projection",
    {
      description: "Run the base plan or a named scenario; returns a thinned, rounded year-by-year projection.",
      inputSchema: { scenario: z.string().optional() },
    },
    ({ scenario }) =>
      guarded(() => {
        const { rows, todays } = session.runProjection(scenario);
        const fi = roundFiStatus(session.fiStatus(scenario));
        return {
          rows: thinRows(rows, fi.retirement_year).map(roundRow),
          todays: thinRows(todays, fi.retirement_year).map(roundRow),
          fi,
        };
      }),
  );

  server.registerTool(
    "fi_status",
    {
      description: "Return FI/coast/depletion year status for the base plan or a named scenario.",
      inputSchema: { scenario: z.string().optional() },
    },
    ({ scenario }) => guarded(() => roundFiStatus(session.fiStatus(scenario))),
  );

  server.registerTool(
    "run_scenario",
    {
      description: "Define a named scenario from override deltas and return its FI status.",
      inputSchema: { name: z.string(), overrides: z.object(scenarioOverridesShape) },
    },
    ({ name, overrides }) =>
      guarded(() => {
        // extra_expenses/extra_incomes are passthrough records at the zod
        // boundary — Session/planjson validate their actual Expense/Income
        // shape at run time; a bad entry surfaces as a structured tool
        // error via `guarded`, not a crash.
        session.defineScenario(name, overrides as ScenarioOverrides);
        return { name, fi: roundFiStatus(session.fiStatus(name)) };
      }),
  );

  server.registerTool(
    "compare_scenarios",
    {
      description: "Compare previously-defined scenarios by name against the first as baseline.",
      inputSchema: { names: z.array(z.string()) },
    },
    ({ names }) =>
      guarded(() => {
        const cmp = session.compareScenarios(names);
        const series: Record<string, YearRow[]> = {};
        for (const [name, rows] of Object.entries(cmp.series)) {
          series[name] = rows.map(roundRow);
        }
        const deltas: Record<string, { fi_year_delta: number | null; terminal_delta: number }> = {};
        for (const [name, d] of Object.entries(cmp.deltas)) {
          deltas[name] = { fi_year_delta: d.fi_year_delta, terminal_delta: Math.round(d.terminal_delta) };
        }
        return { years: cmp.years, series, deltas };
      }),
  );

  return server;
}

export async function runStdio(): Promise<void> {
  const server = createServer(new Session());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
