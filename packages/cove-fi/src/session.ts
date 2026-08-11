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
 * `inflation`, and `ret` are written straight into the copied plan's
 * `assumptions` (so `run()` is always called with no second argument —
 * `last_work_year` and everything else the engine derives from
 * `assumptions` sees the override automatically). `savings_rate_multiplier`
 * scales every contribution rung's `amount` and `pct_of_income`; a
 * `to_limit` rung has no scalar to scale, so it is converted into a fixed
 * `amount = IRS_LIMITS_2026[annual_limit_key] * multiplier` (still in 2026
 * dollars — the engine inflates it like any other `amount` rung) with
 * `to_limit` dropped to `false`. `ss_haircut`/`ss_claim_year` overwrite
 * those fields on every `SocialSecurity` entry. `extra_expenses` and
 * `extra_incomes` append to the plan's existing lists.
 */
import { readFileSync } from "node:fs";
import { run, type YearRow } from "./engine.js";
import { type Assumptions, type Expense, type Income, IRS_LIMITS_2026, type Plan } from "./model.js";
import { loadPlan } from "./planfile.js";

export interface ScenarioOverrides {
  retirement_year?: number;
  inflation?: number;
  ret?: number;
  savings_rate_multiplier?: number; // scales every Contribution amount/pct/limit-want
  ss_haircut?: number;
  ss_claim_year?: number;
  extra_expenses?: Expense[];
  extra_incomes?: Income[];
}

export interface FiStatus {
  fi_year: number | null;
  coast_year: number | null;
  depletion_year: number | null;
  terminal_net_worth: number;
  terminal_net_worth_todays: number;
  retirement_year: number;
}

export interface ProjectionResult {
  rows: YearRow[];
  todays: YearRow[]; // todays = each metric / (1+inflation)^(y-start)
}

const DOLLAR_METRICS = [
  "net_worth",
  "liquid_net_worth",
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

/** Same rule as the engine's internal coast-year trigger (literal 4x, trailing 3-year average expenses), recomputed from finished rows. */
function computeCoastYear(rows: YearRow[]): number | null {
  const spendHist: number[] = [];
  for (const r of rows) {
    spendHist.push(r.expenses);
    const tail = spendHist.slice(-3);
    const avg = tail.reduce((s, v) => s + v, 0) / Math.min(spendHist.length, 3);
    if (r.liquid_net_worth >= 4 * avg) {
      return r.year;
    }
  }
  return null;
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

function computeFiStatus(rows: YearRow[], a: Assumptions): FiStatus {
  const last = rows.at(-1)!;
  const factor = (1 + a.inflation) ** (last.year - a.start_year);
  return {
    fi_year: computeFiYear(rows, a.fi_multiple),
    coast_year: computeCoastYear(rows),
    depletion_year: computeDepletionYear(rows, a.retirement_year),
    terminal_net_worth: last.net_worth,
    terminal_net_worth_todays: last.net_worth / factor,
    retirement_year: a.retirement_year,
  };
}

export class Session {
  plan: Plan | null = null;
  planPath: string | null = null;
  scenarios: Map<string, ScenarioOverrides> = new Map();

  loadPlanFile(path: string): Plan {
    const text = readFileSync(path, "utf8");
    const plan = loadPlan(text);
    this.plan = plan;
    this.planPath = path;
    return plan;
  }

  defineScenario(name: string, o: ScenarioOverrides): void {
    this.scenarios.set(name, o);
  }

  runProjection(scenario?: string): ProjectionResult {
    const { rows, assumptions } = this.runScenario(scenario);
    return { rows, todays: toTodaysDollars(rows, assumptions) };
  }

  fiStatus(scenario?: string): FiStatus {
    const { rows, assumptions } = this.runScenario(scenario);
    return computeFiStatus(rows, assumptions);
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
      const { rows, assumptions } = this.runScenario(name);
      series[name] = rows;
      statuses[name] = computeFiStatus(rows, assumptions);
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

  private runScenario(scenario?: string): { rows: YearRow[]; assumptions: Assumptions } {
    const plan = this.requirePlan();
    const overlay = this.resolveOverlay(scenario);
    const modified = applyOverrides(plan, overlay);
    return { rows: run(modified), assumptions: modified.assumptions };
  }
}
