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
import type { RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CITED_DEFAULTS } from "../defaults.js";
import { type YearRow } from "../engine.js";
import { METRIC_DEFINITIONS, METRICS_VERSION } from "../metrics.js";
import { type Assumptions, DEFAULT_ASSUMPTIONS, type TaxType } from "../model.js";
import { isValidRet, RET_MAX, RET_MIN } from "../planjson.js";
import { listPlans, resolvePlanRef } from "../planstore.js";
import { seedFromYnab } from "../seed/ynab.js";
import { type CashFlowAuditYear, type FiStatus, Session } from "../session.js";
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

/** Wraps a handler body so any thrown Session/engine error (or rejected
 * promise — `fn` may be sync or async, e.g. seed_from_ynab's network call)
 * becomes a structured tool error instead of crashing the server. `await`
 * on a non-promise value resolves immediately, so this stays a drop-in
 * replacement for every pre-existing synchronous call site. */
async function guarded(fn: () => unknown): Promise<CallToolResult> {
  try {
    return toolOk(await fn());
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
  "earmarked_net_worth",
] as const satisfies readonly (keyof YearRow)[];

function roundRow(row: YearRow): YearRow {
  const out = { ...row };
  for (const k of DOLLAR_ROW_KEYS) out[k] = Math.round(row[k]);
  return out;
}

const AUDIT_DOLLAR_KEYS = ["income", "taxes", "expenses", "contributions", "surplus"] as const satisfies readonly (keyof CashFlowAuditYear)[];

function roundAuditYear(y: CashFlowAuditYear): CashFlowAuditYear {
  const out = { ...y };
  for (const k of AUDIT_DOLLAR_KEYS) out[k] = Math.round(y[k]);
  return out;
}

function roundFiStatus(fi: FiStatus): FiStatus {
  return {
    ...fi,
    terminal_net_worth: Math.round(fi.terminal_net_worth),
    terminal_net_worth_todays: Math.round(fi.terminal_net_worth_todays),
    coast_target_at_retirement: Math.round(fi.coast_target_at_retirement),
    terminal_earmarked_net_worth: Math.round(fi.terminal_earmarked_net_worth),
    terminal_earmarked_net_worth_todays: Math.round(fi.terminal_earmarked_net_worth_todays),
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

// Dotted set_assumption keys for the per-tax-class return overrides
// (assumptions.class_returns.<class>) — class_returns itself has no plain
// numeric value (it's a map), so it can't join ASSUMPTIONS_KEYS above;
// these are handled specially in the set_assumption handler below.
const CLASS_RETURN_TAX_TYPES = ["cash", "taxable", "trad", "roth", "hsa", "529"] as const satisfies readonly TaxType[];
const CLASS_RETURN_KEYS = CLASS_RETURN_TAX_TYPES.map((t) => `class_returns.${t}` as const);
const SET_ASSUMPTION_KEYS = [...ASSUMPTIONS_KEYS, ...CLASS_RETURN_KEYS] as [string, ...string[]];

// get_assumptions pairs each assumption with its citation where one
// exists (CITED_DEFAULTS is a strict subset of Assumptions' keys — e.g.
// retirement_year/start_year have no citation and are simply absent here).
// class_returns.cash has no CITED_DEFAULTS entry (it has no default value —
// it's opt-in, unset by default) so its citation is added by hand.
const ASSUMPTION_CITATIONS: Record<string, string> = {
  ...Object.fromEntries(CITED_DEFAULTS.map((d) => [d.key, d.source])),
  "class_returns.cash": "HYSA/T-bill nominal yield assumption; falls back to ret when unset",
};

// Explicit shapes (not a bare z.record(z.unknown()) passthrough): the
// engine has no validation of its own for extra_expenses/extra_incomes — a
// missing `amount` becomes `undefined * x = NaN`, which then poisons every
// subsequent year's balances silently. Zod must reject a malformed entry
// at the protocol boundary, before it ever reaches Session/engine.
//
// Each shape below is registered against the MCP SDK as `.catchall(z.unknown())`
// (permissive), never `.strict()` — see the long comment above
// `scenarioOverridesShape` for why: the SDK's own schema-validation layer
// runs *before* our tool handler and would otherwise silently strip (or,
// with `.strict()`, opaquely reject with no supported-key list) any typo'd
// field before we ever see it. The matching `*Strict` sibling is used only
// for the handler-side re-check in run_scenario, where we control the
// error message.
const extraExpenseFields = {
  name: z.string(),
  amount: z.number(),
  start: z.number().int(),
  end: z.number().int(),
  growth_over_inflation: z.number().optional(),
  nominal_at_start: z.boolean().optional(),
  fund_from: z.string().optional(),
};
const extraExpenseShape = z.object(extraExpenseFields).catchall(z.unknown());
const extraExpenseStrict = z.object(extraExpenseFields).strict();

const extraIncomeFields = {
  name: z.string(),
  amount: z.number(),
  start: z.number().int(),
  end: z.number().int(),
  taxable: z.boolean().optional(),
  reduces_by_pretax: z.boolean().optional(),
};
const extraIncomeShape = z.object(extraIncomeFields).catchall(z.unknown());
const extraIncomeStrict = z.object(extraIncomeFields).strict();

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
  // 0.5.0: per-rung overrides — see applyOverrides (session.ts) for the full
  // end/keep/scale composition rules. Unlike extra_expenses/extra_incomes
  // above, there's only ONE variant of this nested schema (not a
  // catchall/strict pair): it's always `.strict()`, so an unknown key
  // nested inside `contributions` is rejected by zod itself wherever this
  // shape is used — at the permissive SDK-boundary schema below (nested
  // strictness isn't relaxed by the outer object's `.catchall`) and again
  // at the handler's `scenarioOverridesStrict` re-parse (which spreads this
  // same shape in below). Because scenarioOverridesStrict spreads
  // ...scenarioOverridesShape, adding it once here reaches both.
  contributions: z
    .object({
      end: z.number().int().optional(),
      keep: z.array(z.string()).optional(),
      scale: z.number().min(0).optional(),
    })
    .strict()
    .optional(),
  ss_haircut: z.number().optional(),
  ss_claim_year: z.number().optional(),
  extra_expenses: z.array(extraExpenseShape).optional(),
  extra_incomes: z.array(extraIncomeShape).optional(),
  // Replaces assumptions.class_returns WHOLESALE (not a per-key merge) —
  // see applyOverrides in session.ts. Deterministic run_projection/fi_status
  // only: monte_carlo's rates schedule dominates ret/class_returns for
  // every account, so this override has no effect there.
  class_returns: z.record(z.enum(CLASS_RETURN_TAX_TYPES), z.number().min(RET_MIN).max(RET_MAX)).optional(),
};

// Single source of truth for the supported top-level `run_scenario`
// override keys, used both to build the strict re-check schema below and
// to name the supported set in its error text — Task 5 (or any future
// change) that extends scenarioOverridesShape keeps this in sync
// automatically instead of drifting out of a hand-maintained list.
export const SCENARIO_OVERRIDE_KEYS = Object.keys(scenarioOverridesShape);

// Why two schemas for one field: the MCP SDK parses `run_scenario`'s
// `overrides` argument against whatever we register as its inputSchema
// *before* our tool handler ever runs (confirmed by probing the installed
// SDK — @modelcontextprotocol/sdk@1.30.0's McpServer.validateToolInput
// throws a McpError from the request handler, which is caught and turned
// into an isError CallToolResult by the SDK itself; our handler's `guarded`
// wrapper never gets a chance to run, so it cannot rewrite that message).
// A plain (non-strict) z.object silently *strips* unrecognized keys before
// that point — the original bug: a typo'd override key vanishes and the
// scenario silently runs as an unmodified copy of the base plan. Zod's
// `.strict()` fixes the silent-strip but the SDK surfaces its raw
// "Unrecognized key(s)..." message with no way to append the supported-key
// list (`.strict(message)` only accepts a *static* string, which can't
// name the actual offending key alongside it).
//
// So: the schema registered with the SDK (`scenarioOverridesShape` wrapped
// in `.catchall(z.unknown())` at the registerTool call below) is
// deliberately permissive — known fields keep their real per-field
// validation, but unknown keys pass through untouched instead of being
// stripped. The handler then re-validates the untouched object against
// this strict sibling and throws its own Error (caught by `guarded`) with
// a message naming both the offending key(s) and SCENARIO_OVERRIDE_KEYS.
const scenarioOverridesStrict = z
  .object({
    ...scenarioOverridesShape,
    extra_expenses: z.array(extraExpenseStrict).optional(),
    extra_incomes: z.array(extraIncomeStrict).optional(),
  })
  .strict();

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

  // Capabilities for get_engine_info are collected here, not hand-listed:
  // every tool below is registered through this local wrapper (instead of
  // calling server.registerTool directly), so `toolNames` can never drift
  // from what's actually reachable on this server instance. Scoped per
  // createServer() call (not module-level) so repeated server instances in
  // tests don't accumulate stale names across instances.
  const toolNames: string[] = [];
  function registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    handler: ToolCallback<InputArgs>,
  ): RegisteredTool {
    toolNames.push(name);
    return server.registerTool(name, config, handler);
  }

  registerTool(
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

  registerTool(
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

  registerTool(
    "create_plan",
    {
      description:
        "Create a new plan in the session from a JSON object (accounts/incomes/social_security/expenses/contributions/assumptions/etc). Validates the shape and returns a summary; validation issues are reported in the error text (amounts are annual, today's dollars). Income `amount` values must be GROSS annual dollars — confirm with the user whether a reported income figure is gross or take-home (and convert take-home with `income_gross_from_net`) before using it here. Growth overrides: an account's `ret` and `assumptions.class_returns.<tax-class>` (both finite, in [-0.5, 0.5]) let you set nominal return by account or by tax class, falling back to `assumptions.ret` when unset. A contribution's `name` (unique among named rungs) lets `run_scenario`'s `overrides.contributions.keep` target it by name, and its `hard_end` caps it at a plain calendar year independent of `end`. An account's `earmarked: true` (implies `liquid: false`) excludes its balance from `net_worth`/the retirement drawdown waterfall and reports it separately as `earmarked_net_worth`.",
      inputSchema: { plan: z.record(z.unknown()) },
    },
    ({ plan }) => guarded(() => session.createPlan(plan)),
  );

  registerTool(
    "update_plan",
    {
      description:
        "Patch the session's current plan: `add` appends to array fields (accounts/incomes/expenses/contributions), `set` replaces top-level fields (and shallow-merges `assumptions` — note `set.assumptions.class_returns`, being one key of that shallow merge, is replaced WHOLESALE, not merged per tax-class). At least one of `add`/`set` is required (amounts are annual, today's dollars). Income `amount` values must be GROSS annual dollars — confirm with the user whether a reported income figure is gross or take-home (and convert take-home with `income_gross_from_net`) before using it here. Appended contributions may carry `name` (unique among named rungs — targetable by `run_scenario`'s `overrides.contributions.keep`) and `hard_end` (a plain calendar year cap independent of `end`); appended accounts may carry `earmarked: true` to exclude the balance from `net_worth` and report it under `earmarked_net_worth` instead.",
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

  registerTool(
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

  registerTool(
    "get_assumptions",
    {
      description:
        "Return the loaded plan's assumptions, plus a `citations` map (assumption key -> source justification) for the ones that have one.",
      inputSchema: {},
    },
    () =>
      guarded(() => {
        if (!session.plan) throw new Error("no plan loaded — call load_plan first");
        return { assumptions: session.plan.assumptions, citations: ASSUMPTION_CITATIONS };
      }),
  );

  registerTool(
    "set_assumption",
    {
      description:
        "Mutate one assumption on the loaded plan. `key` also accepts the dotted per-tax-class return " +
        "overrides `class_returns.cash|taxable|trad|roth|hsa|529` — each creates/updates one entry in " +
        "assumptions.class_returns (value must be finite, in [-0.5, 0.5]); use update_plan's " +
        "`set.assumptions.class_returns` instead to replace the whole map at once.",
      inputSchema: { key: z.enum(SET_ASSUMPTION_KEYS), value: z.number() },
    },
    ({ key, value }) =>
      guarded(() => {
        if (!session.plan) throw new Error("no plan loaded — call load_plan first");
        if (key.startsWith("class_returns.")) {
          const cls = key.slice("class_returns.".length) as TaxType;
          if (!isValidRet(value)) {
            throw new Error(`class_returns.${cls} must be a finite number in [${RET_MIN}, ${RET_MAX}] (got ${value})`);
          }
          session.plan.assumptions.class_returns = { ...session.plan.assumptions.class_returns, [cls]: value };
          return session.plan.assumptions;
        }
        session.plan.assumptions[key as keyof Assumptions] = value;
        return session.plan.assumptions;
      }),
  );

  registerTool(
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
          metrics_version: METRICS_VERSION,
        };
      }),
  );

  registerTool(
    "fi_status",
    {
      description: "Return FI/coast/depletion year status for the base plan or a named scenario.",
      inputSchema: { scenario: z.string().optional() },
    },
    ({ scenario }) => guarded(() => ({ ...roundFiStatus(session.fiStatus(scenario)), metrics_version: METRICS_VERSION })),
  );

  registerTool(
    "run_scenario",
    {
      description:
        "Define a named scenario from override deltas and return its FI status. `overrides.class_returns` " +
        "replaces assumptions.class_returns WHOLESALE (not a per-key merge) and only affects deterministic " +
        "projections (run_projection/fi_status/compare_scenarios) — monte_carlo ignores invested return " +
        "overrides (its rates schedule dominates ret/class_returns for every account). " +
        "`overrides.contributions` {end, keep, scale} tunes contribution rungs AFTER " +
        "savings_rate_multiplier (the two compose): `end` (a year) clamps every non-kept rung's " +
        "hard_end — it can only pull the cutoff earlier, never extend it past a rung's own end; " +
        "`keep` (rung names) exempts those rungs from this override's own scale/end (savings_rate_multiplier " +
        "still applies to kept rungs); `scale` multiplies every non-kept rung's amount/pct/limit.",
      // Permissive on purpose — see the comment above scenarioOverridesStrict.
      inputSchema: { name: z.string(), overrides: z.object(scenarioOverridesShape).catchall(z.unknown()) },
    },
    ({ name, overrides }) =>
      guarded(() => {
        const parsed = scenarioOverridesStrict.safeParse(overrides);
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => (i.path.length ? `${i.message} at ${i.path.join(".")}` : i.message))
            .join("; ");
          throw new Error(`${detail}. Supported top-level keys: ${SCENARIO_OVERRIDE_KEYS.join(", ")}`);
        }
        session.defineScenario(name, parsed.data);
        return { name, fi: roundFiStatus(session.fiStatus(name)) };
      }),
  );

  registerTool(
    "monte_carlo",
    {
      description:
        "Run a block-bootstrap Monte Carlo simulation over the base plan or a named scenario; returns success rate and thinned, rounded percentile bands over net worth. Results are NOMINAL dollars — no today's-$ conversion is meaningful per-trial under sampled inflation. Note: ret/inflation/class_returns scenario overrides are ignored — per-year rates come from sampled market history; retirement_year, savings, social-security, and extra income/expense overrides all apply. Cash-class accounts follow a historical T-bill path correlated with the same sampled years as the equity/inflation path (not the equity path itself) — expect narrower percentile bands for cash-heavy plans.",
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

  registerTool(
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

  registerTool(
    "audit_cash_flow",
    {
      description:
        "Per-year cash-flow audit table for the base plan or a named scenario: income/taxes/expenses/" +
        "contributions plus `surplus` (income - taxes - expenses - contributions, ~0 in working years " +
        "under the engine's surplus-spend default) and `flags` — a duplicate income/expense line name " +
        "repeated within a year, or a fund_from (529-funded) expense whose account fell short, drawing " +
        "the rest from household cash flow. Pass `from_year`/`to_year` for an explicit inclusive range; " +
        "omitting both returns a default window sized for a small context window: the first 10 " +
        "projection years plus retirement_year-1..+2 (deduped, sorted) — call again with an explicit " +
        "range to see other years.",
      inputSchema: {
        scenario: z.string().optional(),
        from_year: z.number().int().optional(),
        to_year: z.number().int().optional(),
      },
    },
    ({ scenario, from_year, to_year }) =>
      guarded(() => {
        if (from_year !== undefined || to_year !== undefined) {
          return { years: session.auditCashFlow(scenario, from_year, to_year).map(roundAuditYear) };
        }
        const all = session.auditCashFlow(scenario);
        const retirementYear = session.fiStatus(scenario).retirement_year;
        const wanted = new Set<number>();
        for (const y of all.slice(0, 10)) wanted.add(y.year);
        for (let y = retirementYear - 1; y <= retirementYear + 2; y++) wanted.add(y);
        const years = all
          .filter((y) => wanted.has(y.year))
          .sort((a, b) => a.year - b.year)
          .map(roundAuditYear);
        return { years };
      }),
  );

  registerTool(
    "seed_from_ynab",
    {
      description:
        "PROPOSE-ONLY: reads a YNAB budget (via COVE_FI_YNAB_TOKEN or YNAB_TOKEN) and returns a " +
        "proposed starting point — spending by category group, detected income, and an estimated " +
        "savings rate over the last 6 complete months. Never touches the loaded plan; the caller " +
        "must confirm with the user and pass values into create_plan/update_plan by hand. If no " +
        "token is set, returns `{ configured: false, instructions }` (not an error). Seeded " +
        "figures are MONTHLY; multiply ×12 when building plan entries. NOTE: YNAB-derived income " +
        "is TAKE-HOME (post-tax deposits) — convert it with `income_gross_from_net` before it " +
        "enters a plan; cove-fi plans always store GROSS income.",
      inputSchema: { budget_id: z.string().optional() },
    },
    ({ budget_id }) => guarded(() => seedFromYnab(budget_id === undefined ? undefined : { budgetId: budget_id })),
  );

  registerTool(
    "income_gross_from_net",
    {
      description:
        "PROPOSE-ONLY calculator (never touches the loaded plan): given a take-home (post-tax) " +
        "annual figure, computes the GROSS annual salary that would produce it — " +
        "`gross = net / (1 - (income_tax + local_tax)) + deferrals`. Plans always store GROSS " +
        "income; use this before passing a take-home number (e.g. from a pay stub or YNAB " +
        "deposits) into create_plan/update_plan. `income_tax`/`local_tax` default to the loaded " +
        "plan's assumptions when omitted (an error if no plan is loaded and either is omitted). " +
        "Pass `stated_gross` to reconcile a self-reported gross figure against the computed one — " +
        "the response's `reconciliation.agrees` is true when they're within 1% of each other.",
      inputSchema: {
        net_annual: z.number().positive(),
        deferrals_annual: z.number().min(0).default(0),
        income_tax: z.number().min(0).max(1).optional(),
        local_tax: z.number().min(0).max(1).optional(),
        stated_gross: z.number().positive().optional(),
      },
    },
    ({ net_annual, deferrals_annual, income_tax, local_tax, stated_gross }) =>
      guarded(() => {
        if (income_tax === undefined || local_tax === undefined) {
          if (!session.plan) {
            throw new Error("income_tax and local_tax are required when no plan is loaded");
          }
          income_tax ??= session.plan.assumptions.income_tax;
          local_tax ??= session.plan.assumptions.local_tax;
        }
        const ordinaryRateUsed = income_tax + local_tax;
        if (ordinaryRateUsed >= 1) {
          throw new Error("income_tax + local_tax must be < 1");
        }
        const computedGross = Math.round(net_annual / (1 - ordinaryRateUsed) + deferrals_annual);
        const result: {
          computed_gross: number;
          net_annual: number;
          deferrals_annual: number;
          ordinary_rate_used: number;
          formula: string;
          reconciliation?: { stated_gross: number; computed_gross: number; delta: number; agrees: boolean };
        } = {
          computed_gross: computedGross,
          net_annual: Math.round(net_annual),
          deferrals_annual: Math.round(deferrals_annual),
          ordinary_rate_used: ordinaryRateUsed,
          formula: "gross = net / (1 - (income_tax + local_tax)) + deferrals",
        };
        if (stated_gross !== undefined) {
          const roundedStated = Math.round(stated_gross);
          const delta = computedGross - roundedStated;
          result.reconciliation = {
            stated_gross: roundedStated,
            computed_gross: computedGross,
            delta,
            agrees: Math.abs(delta) <= 0.01 * roundedStated,
          };
        }
        return result;
      }),
  );

  registerTool(
    "get_engine_info",
    {
      description:
        "Handshake tool: reports the running server's version, metrics_version, the live " +
        "run_scenario override key list, metric definitions, and every registered tool name " +
        "(capabilities). Call this first in a new session — no plan needs to be loaded — to " +
        "detect a stale or partial deploy before trusting any other tool's numbers, and to " +
        "check metrics_version whenever a cached metric value (e.g. coast_year) needs to be " +
        "revalidated against its current definition.",
      inputSchema: {},
    },
    () =>
      guarded(() => ({
        version: PACKAGE_VERSION,
        metrics_version: METRICS_VERSION,
        scenario_override_keys: SCENARIO_OVERRIDE_KEYS,
        metric_definitions: METRIC_DEFINITIONS,
        capabilities: [...toolNames],
      })),
  );

  server.registerPrompt(
    "onboard",
    {
      title: "Set up a retirement plan",
      description:
        "Guided interview that builds a Cove FI plan from scratch (or from an existing one): checks for saved plans, offers YNAB seeding, walks a manual interview when needed, and finishes with a projection, Monte Carlo run, and save.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: ONBOARD_PROMPT },
        },
      ],
    }),
  );

  return server;
}

const ONBOARD_PROMPT = `You are guiding the user through setting up a Cove FI retirement plan. Follow these steps in order.

1. Check for existing plans. Call \`list_plans\`. If any are found, tell the user and offer to load one with \`load_plan\` before starting a new plan — don't assume they want to start over.

2. Ask about YNAB. First check whether this client also has budgeting tools you may have connected (a "Cove for YNAB"-style server, or similar) — if so, prefer those for richer category-level detail. Otherwise, ask whether the user tracks their finances in YNAB and, if yes, call \`seed_from_ynab\` to get a proposed starting point (income, spending by category, estimated savings rate). Either way, treat whatever comes back as a PROPOSAL only: read it back to the user in plain, rounded numbers and get their explicit confirmation before it goes into \`create_plan\`/\`update_plan\` — never apply seeded numbers automatically, from either source.

3. Run a manual interview to collect whatever seeding didn't cover (birth years, account balances, and contributions are never in the seed proposal — always ask for these; other sections may already be confirmed from step 2). Ask one section at a time, in this fixed order:
   - Household: who's included, and birth year(s).
   - Accounts & balances: name, \`tax\` (one of \`cash\`|\`taxable\`|\`trad\`|\`roth\`|\`hsa\`|\`529\`), balance, and cost basis where relevant.
   - Income streams: source, amount, and timing. Cove FI plans always store GROSS (pre-tax) annual income — never assume a reported figure is gross. For EVERY income figure, first establish whether it's take-home (post-tax, e.g. a paycheck deposit or YNAB-derived amount) or already gross. If take-home: convert any reported period to annual (a monthly figure ×12), then ask for ALL annual pretax deferrals (401k, HSA, insurance premiums, etc — these can never be inferred from a deposit amount), then call \`income_gross_from_net\`. Read back the full chain to the user — the reported figure (with its period), the annualized net, the deferrals, and the computed gross — for explicit confirmation before you call \`create_plan\` or \`update_plan\` with it.
   - Social Security (optional): ask if the user wants to include SS benefits; if so, collect \`pia_monthly\` and \`claim_year\` for each person.
   - Recurring expenses & housing.
   - Contributions & savings rungs (what gets funded, in what order).
   - Retirement intent: when income should stop — set \`income.end = "retirement"\` for income that ends at retirement rather than a hardcoded year (this may also appear as the numeric sentinel \`-2\`).

4. Build the plan iteratively as you go: as soon as you have the household section, call \`create_plan\`, seeding empty arrays for uncollected sections (\`accounts\`, \`incomes\`, \`social_security\`, \`expenses\`, \`contributions\` as \`[]\`) and \`assumptions: {}\` so the plan exists early — then \`update_plan\` (using \`add\`/\`set\`) after each subsequent section. Plan amounts are annual, today's dollars — convert monthly seed figures ×12, and every income/expense needs start and end years (ask; the seed proposal has none). After every update, read back a short PlanSummary: the counts (accounts, incomes, expenses, contributions) plus \`annual_gross_income\` and \`annual_expenses\` — confirm those two figures with the user before you continue.

5. Once a plan exists, call \`get_assumptions\` and offer its defaults WITH their citations (its \`citations\` field, keyed by assumption name) to the user, letting them override any value via \`set_assumption\` or \`update_plan\`'s \`set.assumptions\`.

6. When the plan is complete, finish with: \`run_projection\`, then \`fi_status\`, then \`monte_carlo\` with 1000 trials. \`monte_carlo\`'s dollar figures are NOMINAL (no today's-$ conversion is meaningful under sampled inflation); \`run_projection\`'s \`todays\` rows give today's-dollar equivalents if the user wants those. Present the resulting story in plain language (when they'd hit FI, how the Monte Carlo success rate looks), then ask the user what to name the plan and call \`save_plan\`. If \`save_plan\` errors because that name already exists, confirm with the user before retrying with \`overwrite: true\` — never overwrite silently.

7. Never invent numbers — ask. Round dollar amounts when reading anything back to the user. Offer assumption defaults with their citations from \`get_assumptions\` rather than picking values yourself.`;

export async function runStdio(): Promise<void> {
  const server = createServer(new Session());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
