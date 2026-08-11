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
import { type FiStatus, Session } from "../session.js";

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
// row thinning (run_projection and compare_scenarios' series — full
// tables stay a CLI/--json concern). Sampling rule: first 5 years, every
// 5th year thereafter, retirement year +/-2, and the final year. Hard
// bound: never returns more than MAX_ROWS rows, regardless of plan
// length — if the sampled set is still too big, it's evenly downsampled
// (see `downsampleIndices`).
// ---------------------------------------------------------------------

const MAX_ROWS = 30;

/** Evenly spaced downsample of a sorted, deduped index list to at most
 * `max` entries. Always keeps the first and last index. */
function downsampleIndices(indices: number[], max: number): number[] {
  if (indices.length <= max) return indices;
  const lastIdx = indices.length - 1;
  const step = lastIdx / (max - 1);
  const out = new Set<number>();
  for (let k = 0; k < max; k++) {
    out.add(indices[Math.round(k * step)]!);
  }
  return [...out].sort((a, b) => a - b);
}

/** The index set thinning keeps, before the hard-bound downsample. Exposed
 * separately from `thinRows` so `compare_scenarios` can apply one shared
 * index set across `years` and every scenario's `series` (they're index-
 * aligned — every scenario shares the same start_year..end_year row
 * count; only *when* retirement happens shifts, not the row count). */
function thinIndices(rows: YearRow[], retirementYear: number): number[] {
  const n = rows.length;
  if (n === 0) return [];
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(5, n); i++) keep.add(i);
  for (let i = 5; i < n; i += 5) keep.add(i);
  for (let i = 0; i < n; i++) {
    if (Math.abs(rows[i]!.year - retirementYear) <= 2) keep.add(i);
  }
  keep.add(n - 1);
  return downsampleIndices([...keep].sort((a, b) => a - b), MAX_ROWS);
}

function thinRows(rows: YearRow[], retirementYear: number): YearRow[] {
  return thinIndices(rows, retirementYear).map((i) => rows[i]!);
}

// ---------------------------------------------------------------------
// zod shapes
// ---------------------------------------------------------------------

const ASSUMPTIONS_KEYS = Object.keys(DEFAULT_ASSUMPTIONS) as [keyof Assumptions, ...(keyof Assumptions)[]];

// Explicit shapes (not a z.record(z.unknown()) passthrough): the engine
// has no validation of its own for extra_expenses/extra_incomes — a
// missing `amount` becomes `undefined * x = NaN`, which then poisons
// every subsequent year's balances silently. Zod must reject a malformed
// entry at the protocol boundary, before it ever reaches Session/engine.
const extraExpenseShape = z.object({
  name: z.string(),
  amount: z.number(),
  start: z.number().int(),
  end: z.number().int(),
  growth_over_inflation: z.number().optional(),
  nominal_at_start: z.boolean().optional(),
  fund_from: z.string().optional(),
});

const extraIncomeShape = z.object({
  name: z.string(),
  amount: z.number(),
  start: z.number().int(),
  end: z.number().int(),
  taxable: z.boolean().optional(),
  reduces_by_pretax: z.boolean().optional(),
});

const scenarioOverridesShape = {
  retirement_year: z.number().optional(),
  inflation: z.number().optional(),
  ret: z.number().optional(),
  savings_rate_multiplier: z.number().optional(),
  ss_haircut: z.number().optional(),
  ss_claim_year: z.number().optional(),
  extra_expenses: z.array(extraExpenseShape).optional(),
  extra_incomes: z.array(extraIncomeShape).optional(),
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
        session.defineScenario(name, overrides);
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
        // Anchor thinning on the loaded (base) plan's retirement_year: a
        // ScenarioOverrides.retirement_year override only shifts *when*
        // retirement happens, never the plan's start_year..end_year row
        // count, so one shared index set stays aligned across `years` and
        // every scenario's `series` without re-deriving it per scenario.
        const anchorYear = session.plan!.assumptions.retirement_year;
        const baseRows = cmp.series[names[0]!]!;
        const indices = thinIndices(baseRows, anchorYear);
        const years = indices.map((i) => cmp.years[i]!);
        const series: Record<string, YearRow[]> = {};
        for (const [name, rows] of Object.entries(cmp.series)) {
          series[name] = indices.map((i) => roundRow(rows[i]!));
        }
        const deltas: Record<string, { fi_year_delta: number | null; terminal_delta: number }> = {};
        for (const [name, d] of Object.entries(cmp.deltas)) {
          deltas[name] = { fi_year_delta: d.fi_year_delta, terminal_delta: Math.round(d.terminal_delta) };
        }
        return { years, series, deltas };
      }),
  );

  return server;
}

export async function runStdio(): Promise<void> {
  const server = createServer(new Session());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
