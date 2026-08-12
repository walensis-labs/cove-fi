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
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type YearRow } from "../engine.js";
import { type Assumptions, DEFAULT_ASSUMPTIONS } from "../model.js";
import { listPlans, resolvePlanRef } from "../planstore.js";
import { type FiStatus, Session } from "../session.js";
import { thinIndices, thinMonteCarloResult, thinRows } from "../thin.js";

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

// row/percentile thinning (run_projection, compare_scenarios' series, and
// monte_carlo — full tables stay a CLI/--json concern) lives in ../thin.js.
// MCP-only: the CLI's `mc --json`/`run --json`/`compare --json` output is
// always full-resolution, untruncated.

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

// update_plan requires at least one of add/set — expressed as a refine on
// a standalone object schema (registerTool's inputSchema wants a raw shape,
// not a ZodObject, so this is parsed by hand in the handler rather than
// passed as the tool's inputSchema).
const updatePlanArgsSchema = z
  .object({ add: z.record(z.unknown()).optional(), set: z.record(z.unknown()).optional() })
  .refine((v) => v.add !== undefined || v.set !== undefined, {
    message: "update_plan requires at least one of `add` or `set`",
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

// Two candidate depths: "../../package.json" is correct when this file runs
// as source (src/mcp/server.ts, e.g. under vitest); "../package.json" is
// correct when it runs from the built bundle, where tsup's code-splitting
// places the dynamically-imported chunk directly in dist/ (flat, same
// depth as dist/cli.js) rather than mirroring src/mcp/'s nesting.
function readPackageVersion(): string {
  const req = createRequire(import.meta.url);
  try {
    return req("../../package.json").version;
  } catch {
    return req("../package.json").version;
  }
}
const PACKAGE_VERSION: string = readPackageVersion();

export function createServer(session: Session): McpServer {
  const server = new McpServer({ name: "cove-fi", version: PACKAGE_VERSION });

  server.registerTool(
    "load_plan",
    {
      description:
        "Load a plan into the session. `path` accepts either a bare saved-plan name (resolved against ~/.cove-fi/plans or COVE_FI_PLANS, e.g. \"my-plan\") or an absolute/relative path to a plan TOML file.",
      inputSchema: { path: z.string() },
    },
    ({ path }) =>
      guarded(() => {
        const resolved = resolvePlanRef(path);
        session.loadPlanFile(resolved);
        return { path: resolved, loaded: true };
      }),
  );

  server.registerTool(
    "list_plans",
    {
      description:
        "List discoverable saved plans (from the plan store and the current working directory), most recently touched first.",
      inputSchema: {},
    },
    () =>
      guarded(() => {
        const plans = listPlans();
        if (plans.length === 0) {
          return { plans, hint: "No plans found. Use the onboard prompt, create_plan, or seed_from_ynab." };
        }
        return { plans };
      }),
  );

  server.registerTool(
    "create_plan",
    {
      description:
        "Create a new plan in the session from a JSON object (accounts/incomes/expenses/contributions/assumptions/etc). Validates the shape and returns a summary; validation issues are reported in the error text.",
      inputSchema: { plan: z.record(z.unknown()) },
    },
    ({ plan }) => guarded(() => session.createPlan(plan)),
  );

  server.registerTool(
    "update_plan",
    {
      description:
        "Patch the session's current plan: `add` appends to array fields (accounts/incomes/expenses/contributions), `set` replaces top-level fields (and shallow-merges `assumptions`). At least one of `add`/`set` is required.",
      inputSchema: {
        add: z.record(z.unknown()).optional(),
        set: z.record(z.unknown()).optional(),
      },
    },
    (args) => {
      const parsed = updatePlanArgsSchema.safeParse(args);
      if (!parsed.success) {
        return toolError(new Error("update_plan requires at least one of `add` or `set`"));
      }
      return guarded(() => session.updatePlan(parsed.data));
    },
  );

  server.registerTool(
    "save_plan",
    {
      description: "Persist the session's current plan to the plan store under `name`.",
      inputSchema: { name: z.string(), overwrite: z.boolean().default(false) },
    },
    ({ name, overwrite }) =>
      guarded(() => {
        const path = session.saveCurrentPlan(name, overwrite);
        return { path };
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
    "monte_carlo",
    {
      description:
        "Run a block-bootstrap Monte Carlo simulation over the base plan or a named scenario; returns success rate and thinned, rounded percentile bands over net worth. Results are NOMINAL dollars — no today's-$ conversion is meaningful per-trial under sampled inflation. Note: ret/inflation scenario overrides are ignored — per-year rates come from sampled market history; retirement_year, savings, social-security, and extra income/expense overrides all apply.",
      inputSchema: {
        scenario: z.string().optional(),
        trials: z.number().int().min(1).max(10_000).default(1000),
        seed: z.number().int().optional(),
      },
    },
    ({ scenario, trials, seed }) =>
      guarded(() => {
        const mc = session.monteCarlo(scenario, trials, seed);
        const retirementYear = session.fiStatus(scenario).retirement_year;
        return thinMonteCarloResult(mc, retirementYear);
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
        const indices = thinIndices(cmp.years, anchorYear);
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
