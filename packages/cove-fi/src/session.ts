/**
 * Session layer — scenario overlays, FI status, and comparisons.
 *
 * The single function layer both the CLI (Task 7) and the MCP server
 * (Task 8) wrap. `Session` owns at most one loaded `Plan` plus a set of
 * named `ScenarioOverrides`; every read method (`runProjection`,
 * `fiStatus`, `compareScenarios`) takes an optional scenario name — omit
 * it to run the base plan unmodified, or name a scenario previously
 * registered with `defineScenario`.
 *
 * `applyOverrides` is the one code path for turning a `Plan` +
 * `ScenarioOverrides` into a modified `Plan`: `retirement_year`,
 * `inflation`, `ret`, and `class_returns` are written straight into the
 * copied plan's `assumptions` (so `run()` is always called with no second
 * argument — `last_work_year` and everything else the engine derives from
 * `assumptions` sees the override automatically); `class_returns` REPLACES
 * the plan's whole map wholesale when provided, not a per-key merge, and
 * only ever affects deterministic runs — Monte Carlo's rates schedule
 * dominates ret/class_returns for every account (see `engine.ts`).
 * `savings_rate_multiplier`
 * scales every contribution rung's `amount` and `pct_of_income`; a
 * `to_limit` rung has no scalar to scale, so it is converted into a fixed
 * `amount = IRS_LIMITS_2026[annual_limit_key] * multiplier` (still in 2026
 * dollars — the engine inflates it like any other `amount` rung) with
 * `to_limit` dropped to `false`. `contributions` {end, keep, scale} applies
 * AFTER `savings_rate_multiplier` (so the two COMPOSE — a rung can be
 * scaled by both in sequence): `keep` is resolved first — every name must
 * match a currently-named rung or the call throws, listing the unknown
 * names (unnamed rungs can never be kept) — then kept rungs are excluded
 * byte-for-byte from both `scale` and `end`; `scale` (>= 0) multiplies
 * every non-kept rung's `amount`/`pct_of_income` and converts a `to_limit`
 * rung the same way `savings_rate_multiplier` does above; `end` (a finite
 * integer year) tightens every non-kept rung's `hard_end` to
 * `min(existing hard_end ?? Infinity, end)` — it can only pull a cutoff
 * earlier, never push it later (the rung's own `end` still governs if it's
 * earlier still). `ss_haircut`/`ss_claim_year` overwrite
 * those fields on every `SocialSecurity` entry. `extra_expenses` and
 * `extra_incomes` append to the plan's existing lists. Any income whose
 * `end` is the `RETIREMENT` sentinel follows `retirement_year` for free —
 * the engine resolves it from the *effective* assumptions, so a
 * `retirement_year` override here moves that income's end date too.
 */
import { readFileSync } from "node:fs";
import { coastTargetAtRetirement, run, runWithMeta, type YearDetail, type YearRow } from "./engine.js";
import {
  type Assumptions,
  type ClassReturns,
  type Contribution,
  type Expense,
  type Income,
  IRS_LIMITS_2026,
  type Plan,
} from "./model.js";
import { runMonteCarlo, type MonteCarloResult } from "./montecarlo.js";
import { loadPlan } from "./planfile.js";
import { planFromJson } from "./planjson.js";
import { savePlan } from "./planstore.js";

export interface ScenarioOverrides {
  retirement_year?: number;
  inflation?: number;
  ret?: number;
  savings_rate_multiplier?: number; // scales every Contribution amount/pct/limit-want
  // 0.5.0: per-rung overrides — see applyOverrides' doc comment above for
  // the full keep/scale/end semantics and their composition with
  // savings_rate_multiplier.
  contributions?: { end?: number; keep?: string[]; scale?: number };
  ss_haircut?: number;
  ss_claim_year?: number;
  extra_expenses?: Expense[];
  extra_incomes?: Income[];
  // Replaces assumptions.class_returns WHOLESALE when provided (not a
  // per-key merge) — see applyOverrides. Deterministic projections only:
  // Monte Carlo's rates schedule dominates ret/class_returns for every
  // account, cash included (engine.ts), so this override has no effect
  // there.
  class_returns?: ClassReturns;
}

export interface FiStatus {
  fi_year: number | null;
  coast_year: number | null;
  coast_target_at_retirement: number; // nominal $; fi_multiple x retirement-year spending (engine.coastTargetAtRetirement)
  depletion_year: number | null;
  terminal_net_worth: number;
  terminal_net_worth_todays: number;
  // 0.5.0: last row's earmarked_net_worth (engine.YearRow) and its
  // today's-$ equivalent — same last-row + deflator pattern as
  // terminal_net_worth/terminal_net_worth_todays above.
  terminal_earmarked_net_worth: number;
  terminal_earmarked_net_worth_todays: number;
  retirement_year: number;
}

export interface ProjectionResult {
  rows: YearRow[];
  todays: YearRow[]; // todays = each metric / (1+inflation)^(y-start)
}

// 0.6.0: the per-year "is this account really funding that gift?" table —
// built over runWithMeta's opt-in YearDetail, one entry per row in range.
// `surplus` makes fungibility questions answerable: it's the household's
// own identity (income - taxes - expenses - contributions), computed from
// the SAME row totals YearDetail reconciles to, so it's exactly 0 (modulo
// float noise) whenever cashFlowDefault: "spend" absorbed every dollar —
// which is every working year by construction (engine.ts folds any surplus
// into `exp` as a synthetic "Discretionary" line before the row is
// finalized). A nonzero surplus in a returned year is not a bug signal by
// itself (retirement years draw down accounts instead of spending a
// working-year surplus), it's just the number this tool exists to show.
export interface CashFlowAuditYear {
  year: number;
  income: number;
  taxes: number;
  expenses: number;
  contributions: number;
  surplus: number; // income - taxes - expenses - contributions
  flags: string[];
}

/** Whole-dollar, comma-grouped formatting for flag message text — flag
 * strings bake in their own rounded figures (they're prose, not a
 * DOLLAR_METRICS-style numeric field a caller could round after the fact). */
function fmtDollars(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Any NAME appearing more than once among a year's income or expense lines
 * (YearDetail, so synthetic engine lines are included — they're always
 * single-instance by construction and can't false-positive, but a user's
 * own expense colliding with a synthetic name, e.g. "Mortgage (P&I)", is a
 * real duplicate worth flagging, not a case to special-case away). */
function duplicateNameFlags(lines: { name: string }[], kind: "income" | "expense"): string[] {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l.name, (counts.get(l.name) ?? 0) + 1);
  const flags: string[] = [];
  for (const [name, n] of counts) {
    if (n > 1) flags.push(`duplicate ${kind} line '${name}' appears ${n}x`);
  }
  return flags;
}

/** A fund_from expense line only ever appears in YearDetail.expenses when
 * its fallthrough (funded_from_cash_flow, === amount) is nonzero — a
 * fully-covered fund_from expense is omitted entirely (see engine.ts's
 * YearDetail doc) — so every fund_from-tagged entry here IS a shortfall by
 * construction; the funded_from_cash_flow > 0 check is kept explicit to
 * document that invariant rather than lean on it silently. */
function fundFromShortfallFlags(expenses: YearDetail["expenses"]): string[] {
  const flags: string[] = [];
  for (const e of expenses) {
    if (e.fund_from && e.funded_from_cash_flow > 0) {
      flags.push(
        `expense '${e.name}' drew ${fmtDollars(e.funded_from_account)} from ${e.fund_from} and ` +
          `${fmtDollars(e.funded_from_cash_flow)} from household cash flow`,
      );
    }
  }
  return flags;
}

export interface PlanSummary {
  accounts: number;
  incomes: number;
  expenses: number;
  contributions: number;
  birth_year: number;
  retirement_year: number;
  annual_gross_income: number; // year-1 row, rounded
  annual_expenses: number; // year-1 row, rounded
}

/** Array fields `updatePlan`'s `add` is allowed to append to. */
const APPENDABLE_FIELDS = new Set(["accounts", "incomes", "expenses", "contributions"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const DOLLAR_METRICS = [
  "net_worth",
  "liquid_net_worth",
  "earmarked_net_worth",
  "income",
  "expenses",
  "taxes",
  "withdrawals",
  "contributions",
] as const;

/** Pure: deep-copies `plan` and never mutates it or `o`. */
export function applyOverrides(plan: Plan, o: ScenarioOverrides): Plan {
  const copy = structuredClone(plan);

  const assumptionOverrides: Partial<Assumptions> = {};
  if (o.retirement_year !== undefined) assumptionOverrides.retirement_year = o.retirement_year;
  if (o.inflation !== undefined) assumptionOverrides.inflation = o.inflation;
  if (o.ret !== undefined) assumptionOverrides.ret = o.ret;
  // structuredClone'd (not aliased) so mutating the returned plan's
  // class_returns can never reach back into the caller's ScenarioOverrides
  // — same purity contract as extra_expenses/extra_incomes below. Spread
  // into copy.assumptions below REPLACES the class_returns key wholesale
  // (not a per-key merge into whatever the base plan already had).
  if (o.class_returns !== undefined) assumptionOverrides.class_returns = structuredClone(o.class_returns);
  if (Object.keys(assumptionOverrides).length > 0) {
    copy.assumptions = { ...copy.assumptions, ...assumptionOverrides };
  }

  if (o.savings_rate_multiplier !== undefined) {
    const m = o.savings_rate_multiplier;
    copy.contributions = copy.contributions.map((c) => {
      if (c.to_limit && c.annual_limit_key) {
        return { ...c, to_limit: false, amount: IRS_LIMITS_2026[c.annual_limit_key] * m };
      }
      return {
        ...c,
        amount: c.amount != null ? c.amount * m : c.amount,
        pct_of_income: c.pct_of_income != null ? c.pct_of_income * m : c.pct_of_income,
      };
    });
  }

  if (o.contributions !== undefined) {
    const { end, keep, scale } = o.contributions;

    if (keep !== undefined && (!Array.isArray(keep) || keep.some((k) => typeof k !== "string"))) {
      throw new Error("applyOverrides: contributions.keep must be an array of strings");
    }
    if (scale !== undefined && !(Number.isFinite(scale) && scale >= 0)) {
      throw new Error("applyOverrides: contributions.scale must be a finite number >= 0");
    }
    if (end !== undefined && !(Number.isFinite(end) && Number.isInteger(end))) {
      throw new Error("applyOverrides: contributions.end must be a finite integer year");
    }

    const keepSet = new Set(keep ?? []);
    if (keepSet.size > 0) {
      const namedRungs = new Set(copy.contributions.filter((c) => c.name != null).map((c) => c.name!));
      const unknown = [...keepSet].filter((k) => !namedRungs.has(k));
      if (unknown.length > 0) {
        throw new Error(
          `applyOverrides: contributions.keep names not found among named rungs (unnamed rungs can never be kept): ${unknown.join(", ")}`,
        );
      }
    }

    copy.contributions = copy.contributions.map((c): Contribution => {
      if (c.name != null && keepSet.has(c.name)) return c; // kept: byte-untouched

      let next = c;
      if (scale !== undefined) {
        if (next.to_limit && next.annual_limit_key) {
          next = { ...next, to_limit: false, amount: IRS_LIMITS_2026[next.annual_limit_key] * scale };
        } else {
          next = {
            ...next,
            amount: next.amount != null ? next.amount * scale : next.amount,
            pct_of_income: next.pct_of_income != null ? next.pct_of_income * scale : next.pct_of_income,
          };
        }
      }
      if (end !== undefined) {
        next = { ...next, hard_end: Math.min(next.hard_end ?? Number.POSITIVE_INFINITY, end) };
      }
      return next;
    });
  }

  if (o.ss_haircut !== undefined || o.ss_claim_year !== undefined) {
    copy.social_security = copy.social_security.map((ss) => ({
      ...ss,
      ...(o.ss_haircut !== undefined ? { haircut: o.ss_haircut } : {}),
      ...(o.ss_claim_year !== undefined ? { claim_year: o.ss_claim_year } : {}),
    }));
  }

  if (o.extra_expenses && o.extra_expenses.length > 0) {
    copy.expenses = [...copy.expenses, ...structuredClone(o.extra_expenses)];
  }
  if (o.extra_incomes && o.extra_incomes.length > 0) {
    copy.incomes = [...copy.incomes, ...structuredClone(o.extra_incomes)];
  }

  return copy;
}

function toTodaysDollars(rows: YearRow[], a: Assumptions): YearRow[] {
  return rows.map((r) => {
    const factor = (1 + a.inflation) ** (r.year - a.start_year);
    const out = { ...r };
    for (const k of DOLLAR_METRICS) {
      out[k] = r[k] / factor;
    }
    return out;
  });
}

function computeFiYear(rows: YearRow[], fiMultiple: number): number | null {
  for (const r of rows) {
    if (r.liquid_net_worth >= fiMultiple * r.expenses) return r.year;
  }
  return null;
}

function computeDepletionYear(rows: YearRow[], retirementYear: number): number | null {
  for (const r of rows) {
    if (r.year >= retirementYear && r.liquid_net_worth <= 0) return r.year;
  }
  return null;
}

function computeFiStatus(rows: YearRow[], a: Assumptions, coastYear: number | null, plan: Plan): FiStatus {
  const last = rows.at(-1)!;
  const factor = (1 + a.inflation) ** (last.year - a.start_year);
  return {
    fi_year: computeFiYear(rows, a.fi_multiple),
    coast_year: coastYear,
    coast_target_at_retirement: coastTargetAtRetirement(plan, a),
    depletion_year: computeDepletionYear(rows, a.retirement_year),
    terminal_net_worth: last.net_worth,
    terminal_net_worth_todays: last.net_worth / factor,
    terminal_earmarked_net_worth: last.earmarked_net_worth,
    terminal_earmarked_net_worth_todays: last.earmarked_net_worth / factor,
    retirement_year: a.retirement_year,
  };
}

export class Session {
  plan: Plan | null = null;
  planPath: string | null = null;
  scenarios: Map<string, ScenarioOverrides> = new Map();
  /** true after createPlan/updatePlan, false after saveCurrentPlan or loadPlanFile. */
  dirty = false;

  loadPlanFile(path: string): Plan {
    const text = readFileSync(path, "utf8");
    const plan = loadPlan(text);
    this.plan = plan;
    this.planPath = path;
    this.dirty = false;
    return plan;
  }

  /** Validates `data` (planFromJson) and, only on success, makes it the session's plan.
   * planPath resets to null (unsaved) and dirty is set. */
  createPlan(data: unknown): PlanSummary {
    const plan = planFromJson(data);
    this.plan = plan;
    this.planPath = null;
    this.dirty = true;
    return this.planSummary();
  }

  /** Patches the current plan on a `structuredClone` and re-validates the merged
   * result with `planFromJson` before swapping it in — a failed patch leaves the
   * session plan (and everything derived from it) bit-identical and throws. */
  updatePlan(patch: { add?: Record<string, unknown>; set?: Record<string, unknown> }): PlanSummary {
    const plan = this.requirePlan();
    const draft = structuredClone(plan) as unknown as Record<string, unknown>;

    if (patch.set) {
      for (const [key, value] of Object.entries(patch.set)) {
        if (key === "assumptions") {
          if (!isPlainObject(value)) {
            throw new Error("updatePlan: set.assumptions must be an object");
          }
          draft.assumptions = { ...(draft.assumptions as Record<string, unknown>), ...value };
        } else {
          draft[key] = value;
        }
      }
    }

    if (patch.add) {
      for (const [key, value] of Object.entries(patch.add)) {
        if (!APPENDABLE_FIELDS.has(key)) {
          throw new Error(
            `updatePlan: add.${key} is not an appendable field — add only accepts ${[...APPENDABLE_FIELDS].join(", ")}`,
          );
        }
        if (!Array.isArray(value)) {
          throw new Error(`updatePlan: add.${key} must be an array of items to append`);
        }
        const existing = Array.isArray(draft[key]) ? (draft[key] as unknown[]) : [];
        draft[key] = [...existing, ...value];
      }
    }

    const validated = planFromJson(draft);
    this.plan = validated;
    this.dirty = true;
    return this.planSummary();
  }

  /** Persists the session's current plan via planstore.savePlan and marks it clean. */
  saveCurrentPlan(name: string, overwrite?: boolean): string {
    const plan = this.requirePlan();
    const path = savePlan(name, plan, { overwrite });
    this.planPath = path;
    this.dirty = false;
    return path;
  }

  defineScenario(name: string, o: ScenarioOverrides): void {
    this.scenarios.set(name, o);
  }

  runProjection(scenario?: string): ProjectionResult {
    const { rows, assumptions } = this.runScenario(scenario);
    return { rows, todays: toTodaysDollars(rows, assumptions) };
  }

  fiStatus(scenario?: string): FiStatus {
    const { rows, assumptions, coastYear, plan } = this.runScenario(scenario);
    return computeFiStatus(rows, assumptions, coastYear, plan);
  }

  /** Resolves the named overlay exactly like runProjection (applyOverrides),
   * then runs the block-bootstrap Monte Carlo over the modified plan.
   * Nominal-dollar only — see montecarlo.ts; no today's-$ conversion here.
   * Note: ret/inflation scenario overrides are ignored — per-year rates come
   * from sampled market history; retirement_year, savings, social-security,
   * and extra income/expense overrides all apply. */
  monteCarlo(scenario?: string, trials = 1000, seed?: number): MonteCarloResult {
    const plan = this.requirePlan();
    const overlay = this.resolveOverlay(scenario);
    const modified = applyOverrides(plan, overlay);
    return runMonteCarlo(modified, { trials, seed });
  }

  compareScenarios(names: string[]): {
    years: number[];
    series: Record<string, YearRow[]>;
    deltas: Record<string, { fi_year_delta: number | null; terminal_delta: number }>;
  } {
    if (names.length === 0) {
      throw new Error("compareScenarios requires at least one scenario name");
    }
    const series: Record<string, YearRow[]> = {};
    const statuses: Record<string, FiStatus> = {};
    for (const name of names) {
      const { rows, assumptions, coastYear, plan } = this.runScenario(name);
      series[name] = rows;
      statuses[name] = computeFiStatus(rows, assumptions, coastYear, plan);
    }
    const baseName = names[0]!;
    const baseStatus = statuses[baseName]!;
    const deltas: Record<string, { fi_year_delta: number | null; terminal_delta: number }> = {};
    for (const name of names) {
      const st = statuses[name]!;
      deltas[name] = {
        fi_year_delta: st.fi_year !== null && baseStatus.fi_year !== null ? st.fi_year - baseStatus.fi_year : null,
        terminal_delta: st.terminal_net_worth - baseStatus.terminal_net_worth,
      };
    }
    return { years: series[baseName]!.map((r) => r.year), series, deltas };
  }

  private planSummary(): PlanSummary {
    const plan = this.plan!;
    const rows = run(plan);
    const year1 = rows[0]!;
    return {
      accounts: plan.accounts.length,
      incomes: plan.incomes.length,
      expenses: plan.expenses.length,
      contributions: plan.contributions.length,
      birth_year: plan.birth_year,
      retirement_year: plan.assumptions.retirement_year,
      annual_gross_income: Math.round(year1.income),
      annual_expenses: Math.round(year1.expenses),
    };
  }

  private requirePlan(): Plan {
    if (!this.plan) {
      throw new Error("no plan loaded — call loadPlanFile or load_plan first");
    }
    return this.plan;
  }

  private resolveOverlay(scenario?: string): ScenarioOverrides {
    if (scenario === undefined) return {};
    const o = this.scenarios.get(scenario);
    if (!o) {
      throw new Error(`unknown scenario "${scenario}" — call defineScenario first`);
    }
    return o;
  }

  /** Runs runWithMeta(plan, undefined, undefined, opts) over the resolved scenario overlay.
   * `opts` is passed straight through — omitted (or `{}`) by every caller except
   * auditCashFlow, so `detail` stays `undefined` and behavior/output is unchanged for
   * every pre-existing call site. */
  private runScenario(
    scenario?: string,
    opts?: { detail?: boolean },
  ): { rows: YearRow[]; assumptions: Assumptions; coastYear: number | null; plan: Plan; detail?: YearDetail[] } {
    const plan = this.requirePlan();
    const overlay = this.resolveOverlay(scenario);
    const modified = applyOverrides(plan, overlay);
    const { rows, coast_year, detail } = runWithMeta(modified, undefined, undefined, opts);
    return { rows, assumptions: modified.assumptions, coastYear: coast_year, plan: modified, detail };
  }

  /** The per-year cash-flow audit table: identity (surplus) plus two flag
   * classes (duplicate line names, fund_from shortfalls) built over
   * runWithMeta's opt-in YearDetail. `fromYear`/`toYear` are an inclusive
   * range over row.year; omitting either (or both) leaves that bound open —
   * omitting both returns the full projection horizon. Default windowing
   * for a small context payload (first 10 years + retirement transition) is
   * an MCP-layer concern (mcp/server.ts), not this method's — same split as
   * thin.ts's row thinning. */
  auditCashFlow(scenario?: string, fromYear?: number, toYear?: number): CashFlowAuditYear[] {
    const { rows, detail } = this.runScenario(scenario, { detail: true });
    const out: CashFlowAuditYear[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (fromYear !== undefined && row.year < fromYear) continue;
      if (toYear !== undefined && row.year > toYear) continue;
      const yd = detail![i]!;
      const flags = [
        ...duplicateNameFlags(yd.incomes, "income"),
        ...duplicateNameFlags(yd.expenses, "expense"),
        ...fundFromShortfallFlags(yd.expenses),
      ];
      out.push({
        year: row.year,
        income: row.income,
        taxes: row.taxes,
        expenses: row.expenses,
        contributions: row.contributions,
        surplus: row.income - row.taxes - row.expenses - row.contributions,
        flags,
      });
    }
    return out;
  }
}
