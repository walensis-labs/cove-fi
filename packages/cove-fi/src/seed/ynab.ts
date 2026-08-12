/**
 * seed_from_ynab — PROPOSE-ONLY seeding from a user's YNAB budget via
 * `@walensis/ynab-client`. This module never touches `session.plan`; it
 * returns a `SeedProposal` for the caller (typically the `onboard` MCP
 * prompt) to read back to the user and, only on explicit confirmation, feed
 * into `create_plan`/`update_plan` by hand.
 *
 * Auth is opt-in and read-only: absent a token, `seedFromYnab` returns a
 * normal (non-throwing) `{ configured: false, instructions }` — not an
 * error — so a client can always call it to discover whether YNAB seeding
 * is available.
 */
import { YnabClient } from "@walensis/ynab-client";

export interface SeedProposal {
  configured: boolean;
  instructions?: string;
  budget_name?: string;
  months_analyzed?: number;
  monthly_spending_by_group?: { group: string; monthly: number }[]; // top 10, rounded
  detected_income?: { name: string; monthly_amount: number }[];
  estimated_annual_expenses?: number;
  estimated_savings_rate?: number;
  notes?: string[];
}

// The client's request paths are `/plans/...` (the vendored client's own
// internal naming for YNAB "budgets" — see its README) even though the
// concept is a YNAB budget; this module's public vocabulary (SeedProposal's
// `budget_name`, the `budget_id` MCP arg) stays "budget" to match what a
// YNAB user calls it.
const PLANS_PATH = "/plans";

// "Last 6 complete months" — the current, still-in-progress month is
// excluded on both ends: `sinceDate` is the first day of the month 6
// months before the current one, `untilDate` is the first day of the
// current month (used as an exclusive upper bound on transaction dates).
const MONTHS_BACK = 6;

// YNAB's own name for its "uncategorized inflow" bucket — every inflow
// transaction the user hasn't assigned to a spending category lands here.
// Used as this module's income heuristic (see the note pushed onto
// `notes[]` below): income that a user *has* categorized directly (e.g.
// auto-assigned to a "Paycheck" category) will be missed by this heuristic.
const INFLOW_CATEGORY_NAME = "Inflow: Ready to Assign";

interface RawPlan {
  id: string;
  name: string;
}

interface RawCategory {
  id: string;
  hidden?: boolean;
  deleted?: boolean;
}

interface RawCategoryGroup {
  name: string;
  hidden?: boolean;
  deleted?: boolean;
  categories?: RawCategory[];
}

interface RawTxn {
  id: string;
  date: string;
  amount: number; // milliunits
  deleted?: boolean;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  transfer_account_id?: string | null;
}

/** COVE_FI_YNAB_TOKEN takes precedence over the bare YNAB_TOKEN (matching
 * this package's other COVE_FI_-prefixed env overrides, e.g. COVE_FI_PLANS
 * in planstore.ts) — read live on every call (not cached at module load)
 * so tests can stub it per-test with `vi.stubEnv`. */
export function ynabToken(): string | undefined {
  return process.env.COVE_FI_YNAB_TOKEN || process.env.YNAB_TOKEN || undefined;
}

function unconfigured(): SeedProposal {
  return {
    configured: false,
    instructions:
      "seed_from_ynab needs a YNAB Personal Access Token. Set the COVE_FI_YNAB_TOKEN or YNAB_TOKEN " +
      "environment variable to one. Create a token in the YNAB web app: Account Settings -> " +
      "Developer Settings -> New Token (https://app.ynab.com/settings/developer).",
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function monthStartIso(year: number, monthIndex0: number): string {
  return `${year}-${String(monthIndex0 + 1).padStart(2, "0")}-01`;
}

export async function seedFromYnab(opts?: { budgetId?: string }): Promise<SeedProposal> {
  const token = ynabToken();
  if (!token) return unconfigured();

  const client = new YnabClient({ token });
  const notes: string[] = [];

  const plansData = await client.request<{ plans: RawPlan[] }>(PLANS_PATH);
  const plans = plansData.plans ?? [];
  if (plans.length === 0) {
    throw new Error("No YNAB budgets found for this token.");
  }

  let plan: RawPlan;
  if (opts?.budgetId) {
    const found = plans.find((p) => p.id === opts.budgetId);
    if (!found) throw new Error(`No YNAB budget found with id "${opts.budgetId}".`);
    plan = found;
  } else if (plans.length === 1) {
    plan = plans[0]!;
  } else {
    plan = plans[0]!;
    notes.push(
      `Multiple YNAB budgets found (${plans.map((p) => p.name).join(", ")}); used "${plan.name}" — ` +
        "pass budget_id to pick a different one.",
    );
  }

  const now = new Date();
  const currentMonthYear = now.getUTCFullYear();
  const currentMonthIndex0 = now.getUTCMonth();
  const sinceMonthTotal = currentMonthYear * 12 + currentMonthIndex0 - MONTHS_BACK;
  const sinceDate = monthStartIso(Math.floor(sinceMonthTotal / 12), ((sinceMonthTotal % 12) + 12) % 12);
  const untilDate = monthStartIso(currentMonthYear, currentMonthIndex0);

  const [txnsData, catsData] = await Promise.all([
    client.request<{ transactions: RawTxn[] }>(`${PLANS_PATH}/${plan.id}/transactions`, {
      query: { since_date: sinceDate },
    }),
    client.request<{ category_groups: RawCategoryGroup[] }>(`${PLANS_PATH}/${plan.id}/categories`),
  ]);

  const categoryGroup = new Map<string, string>();
  for (const g of catsData.category_groups ?? []) {
    if (g.deleted) continue;
    for (const c of g.categories ?? []) {
      if (c.deleted) continue;
      categoryGroup.set(c.id, g.name);
    }
  }

  const spendingByGroup = new Map<string, number>();
  const incomeByPayee = new Map<string, number>();

  for (const t of txnsData.transactions ?? []) {
    if (t.deleted) continue;
    if (t.date < sinceDate || t.date >= untilDate) continue; // enforce the 6-complete-months window
    if (t.transfer_account_id) continue; // transfers excluded entirely — neither spending nor income

    const amount = t.amount / 1000; // milliunits -> dollars
    const isInflowCategory = t.category_name === INFLOW_CATEGORY_NAME;

    if (isInflowCategory) {
      if (amount > 0) {
        const name = t.payee_name?.trim() || "Other income";
        incomeByPayee.set(name, (incomeByPayee.get(name) ?? 0) + amount);
      }
      continue; // inflow categories excluded from spending regardless of sign
    }

    if (amount < 0) {
      const group = (t.category_id && categoryGroup.get(t.category_id)) || "Uncategorized";
      spendingByGroup.set(group, (spendingByGroup.get(group) ?? 0) + -amount);
    }
  }

  notes.push(
    `Income detected from transactions YNAB categorizes "${INFLOW_CATEGORY_NAME}" (its default bucket ` +
      "for un-assigned inflows), grouped by payee — income you've assigned directly to a spending " +
      "category on entry will be missed by this heuristic.",
  );

  const monthlySpendingByGroup = [...spendingByGroup.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([group, total]) => ({ group, monthly: Math.round(total / MONTHS_BACK) }));

  const detectedIncome = [...incomeByPayee.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => ({ name, monthly_amount: Math.round(total / MONTHS_BACK) }));

  const totalExpensesMonthly = [...spendingByGroup.values()].reduce((s, v) => s + v, 0) / MONTHS_BACK;
  const totalIncomeMonthly = [...incomeByPayee.values()].reduce((s, v) => s + v, 0) / MONTHS_BACK;

  let estimatedSavingsRate: number;
  if (totalIncomeMonthly <= 0) {
    estimatedSavingsRate = 0;
    notes.push("No income detected in the analyzed window; estimated_savings_rate defaulted to 0.");
  } else {
    estimatedSavingsRate = clamp01(1 - totalExpensesMonthly / totalIncomeMonthly);
  }

  return {
    configured: true,
    budget_name: plan.name,
    months_analyzed: MONTHS_BACK,
    monthly_spending_by_group: monthlySpendingByGroup,
    detected_income: detectedIncome,
    estimated_annual_expenses: Math.round(totalExpensesMonthly * 12),
    estimated_savings_rate: estimatedSavingsRate,
    notes,
  };
}
