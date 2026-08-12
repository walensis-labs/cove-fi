/**
 * JSON -> Plan validation.
 *
 * Structural validation only (no runtime schema dependency), by hand,
 * mirroring the Python-side dataclass shapes in model.ts. Collects EVERY
 * issue before throwing once, so a caller can show a full list rather than
 * whack-a-mole one error at a time.
 *
 * Two checks here exist specifically to close footguns in engine.ts that a
 * malformed plan can otherwise ride straight into NaN/0 silently:
 *   - a contribution's `account` must name a real account (engine indexes
 *     `bal[account]` with a non-null assertion)
 *   - a contribution rung must carry at least one of amount / pct_of_income
 *     / (to_limit + annual_limit_key), the three ways engine.ts computes
 *     `want`; otherwise it falls through to `c.amount!` on `undefined`
 *   - an expense's `fund_from` must name a real account for the same reason
 *     (engine indexes `bal[fund_from]` directly)
 */
import { COAST, type Plan, RETIREMENT, type TaxType, normalizePlan } from "./model.js";

const TAX_TYPES: readonly TaxType[] = ["cash", "taxable", "trad", "roth", "hsa", "529"];
const LIMIT_KEYS = new Set(["401k", "ira", "hsa_family"]);

export class PlanValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`Invalid plan:\n- ${issues.join("\n- ")}`);
    this.name = "PlanValidationError";
    this.issues = issues;
  }
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}
// end < start check that treats sentinel values (COAST = -1, RETIREMENT =
// -2) as "not a real year" rather than as an earlier-than-everything date,
// wherever the caller says that sentinel is legal for this field.
function endBeforeStart(start: unknown, end: unknown, sentinels: readonly number[]): boolean {
  if (!isNum(start) || !isNum(end)) return false;
  if (sentinels.includes(start) || sentinels.includes(end)) return false;
  return end < start;
}

export function planFromJson(data: unknown): Plan {
  if (!isObj(data)) {
    throw new PlanValidationError(["plan must be a JSON object"]);
  }
  const d = data;
  const issues: string[] = [];

  if (!isNum(d.birth_year)) issues.push("birth_year must be a number");

  // ---------- accounts ----------
  const accountNames = new Set<string>();
  const accounts = isArr(d.accounts) ? d.accounts : [];
  if (!isArr(d.accounts)) issues.push("accounts must be an array");
  accounts.forEach((raw, i) => {
    if (!isObj(raw)) {
      issues.push(`accounts[${i}] must be an object`);
      return;
    }
    const label = isStr(raw.name) ? `accounts.${raw.name}` : `accounts[${i}]`;
    if (!isStr(raw.name)) issues.push(`accounts[${i}].name must be a non-empty string`);
    else accountNames.add(raw.name);
    if (!TAX_TYPES.includes(raw.tax as TaxType)) {
      issues.push(`${label}.tax must be one of ${TAX_TYPES.join(", ")} (got ${JSON.stringify(raw.tax)})`);
    }
    if (!isNum(raw.balance)) issues.push(`${label}.balance must be a number (got ${JSON.stringify(raw.balance)})`);
    if (raw.growth != null && !isNum(raw.growth)) issues.push(`${label}.growth must be a number or null`);
    if (raw.liquid != null && !isBool(raw.liquid)) issues.push(`${label}.liquid must be a boolean`);
    if (raw.penalty_age != null && !isNum(raw.penalty_age)) issues.push(`${label}.penalty_age must be a number`);
    if (raw.penalty_rate != null && !isNum(raw.penalty_rate)) issues.push(`${label}.penalty_rate must be a number`);
    if (raw.rmd != null && !isBool(raw.rmd)) issues.push(`${label}.rmd must be a boolean`);
    if (raw.basis != null && !isNum(raw.basis)) issues.push(`${label}.basis must be a number or null`);
  });

  // ---------- incomes ----------
  const incomes = isArr(d.incomes) ? d.incomes : [];
  if (!isArr(d.incomes)) issues.push("incomes must be an array");
  incomes.forEach((raw, i) => {
    if (!isObj(raw)) {
      issues.push(`incomes[${i}] must be an object`);
      return;
    }
    const label = isStr(raw.name) ? `incomes.${raw.name}` : `incomes[${i}]`;
    if (!isNum(raw.amount)) issues.push(`${label}.amount must be a number`);
    if (!isNum(raw.start)) issues.push(`${label}.start must be a number`);
    if (!isNum(raw.end)) issues.push(`${label}.end must be a number`);
    if (endBeforeStart(raw.start, raw.end, [RETIREMENT]))
      issues.push(`${label}: end (${raw.end}) is before start (${raw.start})`);
    if (raw.start === RETIREMENT)
      issues.push(`${label}.start cannot be the RETIREMENT sentinel (-2) — RETIREMENT is only valid on income.end`);
    if (raw.taxable != null && !isBool(raw.taxable)) issues.push(`${label}.taxable must be a boolean`);
    if (raw.reduces_by_pretax != null && !isBool(raw.reduces_by_pretax))
      issues.push(`${label}.reduces_by_pretax must be a boolean`);
  });

  // ---------- social_security ----------
  const socialSecurity = isArr(d.social_security) ? d.social_security : [];
  if (!isArr(d.social_security)) issues.push("social_security must be an array");
  socialSecurity.forEach((raw, i) => {
    if (!isObj(raw)) {
      issues.push(`social_security[${i}] must be an object`);
      return;
    }
    const label = `social_security[${i}]`;
    if (!isNum(raw.pia_monthly)) issues.push(`${label}.pia_monthly must be a number`);
    if (!isNum(raw.claim_year)) issues.push(`${label}.claim_year must be a number`);
    if (raw.haircut != null && !isNum(raw.haircut)) issues.push(`${label}.haircut must be a number`);
    if (raw.taxable_fraction != null && !isNum(raw.taxable_fraction))
      issues.push(`${label}.taxable_fraction must be a number`);
  });

  // ---------- expenses ----------
  const expenses = isArr(d.expenses) ? d.expenses : [];
  if (!isArr(d.expenses)) issues.push("expenses must be an array");
  expenses.forEach((raw, i) => {
    if (!isObj(raw)) {
      issues.push(`expenses[${i}] must be an object`);
      return;
    }
    const label = isStr(raw.name) ? `expenses.${raw.name}` : `expenses[${i}]`;
    if (!isNum(raw.amount)) issues.push(`${label}.amount must be a number`);
    if (!isNum(raw.start)) issues.push(`${label}.start must be a number`);
    if (!isNum(raw.end)) issues.push(`${label}.end must be a number`);
    if (endBeforeStart(raw.start, raw.end, [])) issues.push(`${label}: end (${raw.end}) is before start (${raw.start})`);
    if (raw.start === RETIREMENT || raw.end === RETIREMENT)
      issues.push(`${label}: RETIREMENT sentinel (-2) is only valid on income.end`);
    if (raw.growth_over_inflation != null && !isNum(raw.growth_over_inflation))
      issues.push(`${label}.growth_over_inflation must be a number`);
    if (raw.nominal_at_start != null && !isBool(raw.nominal_at_start))
      issues.push(`${label}.nominal_at_start must be a boolean`);
    if (raw.fund_from != null) {
      if (!isStr(raw.fund_from)) {
        issues.push(`${label}.fund_from must be a string account name`);
      } else if (isArr(d.accounts) && !accountNames.has(raw.fund_from)) {
        issues.push(`${label}.fund_from references unknown account "${raw.fund_from}"`);
      }
    }
  });

  // ---------- contributions ----------
  const contributions = isArr(d.contributions) ? d.contributions : [];
  if (!isArr(d.contributions)) issues.push("contributions must be an array");
  contributions.forEach((raw, i) => {
    if (!isObj(raw)) {
      issues.push(`contributions[${i}] must be an object`);
      return;
    }
    const label = `contributions[${i}]`;
    if (!isStr(raw.account)) {
      issues.push(`${label}.account must be a string account name`);
    } else if (isArr(d.accounts) && !accountNames.has(raw.account)) {
      issues.push(`${label}.account references unknown account "${raw.account}"`);
    }
    if (!isNum(raw.start)) issues.push(`${label}.start must be a number`);
    if (!isNum(raw.end)) issues.push(`${label}.end must be a number`);
    if (endBeforeStart(raw.start, raw.end, [COAST]))
      issues.push(`${label}: end (${raw.end}) is before start (${raw.start})`);
    if (raw.start === RETIREMENT || raw.end === RETIREMENT)
      issues.push(`${label}: RETIREMENT sentinel (-2) is only valid on income.end`);
    if (raw.amount != null && !isNum(raw.amount)) issues.push(`${label}.amount must be a number or null`);
    if (raw.pct_of_income != null && !isNum(raw.pct_of_income))
      issues.push(`${label}.pct_of_income must be a number or null`);
    if (raw.annual_limit_key != null && !LIMIT_KEYS.has(raw.annual_limit_key as string))
      issues.push(`${label}.annual_limit_key must be one of ${[...LIMIT_KEYS].join(", ")} or null`);
    if (raw.to_limit != null && !isBool(raw.to_limit)) issues.push(`${label}.to_limit must be a boolean`);
    if (raw.employer_match_pct != null && !isNum(raw.employer_match_pct))
      issues.push(`${label}.employer_match_pct must be a number or null`);
    if (raw.employer_match_flat != null && !isNum(raw.employer_match_flat))
      issues.push(`${label}.employer_match_flat must be a number or null`);
    if (raw.pretax != null && !isBool(raw.pretax)) issues.push(`${label}.pretax must be a boolean`);
    // engine.ts computes `want` from amount, pct_of_income, or
    // (to_limit && annual_limit_key) — anything else falls through to
    // `c.amount!` on undefined and silently yields NaN.
    const hasAmount = isNum(raw.amount);
    const hasPct = isNum(raw.pct_of_income);
    const hasToLimit = raw.to_limit === true && isStr(raw.annual_limit_key);
    if (!hasAmount && !hasPct && !hasToLimit) {
      issues.push(
        `${label} must set amount, pct_of_income, or (to_limit with annual_limit_key) — otherwise the rung has no way to compute a contribution`,
      );
    }
  });

  // ---------- house ----------
  if (d.house != null) {
    if (!isObj(d.house)) {
      issues.push("house must be an object or null");
    } else {
      const house = d.house;
      if (!isNum(house.value)) issues.push("house.value must be a number");
      if (!isNum(house.appreciation)) issues.push("house.appreciation must be a number");
      if (house.mortgage != null) {
        if (!isObj(house.mortgage)) {
          issues.push("house.mortgage must be an object or null");
        } else {
          const m = house.mortgage;
          if (!isNum(m.balance)) issues.push("house.mortgage.balance must be a number");
          if (!isNum(m.rate)) issues.push("house.mortgage.rate must be a number");
          if (!isNum(m.payment_monthly)) issues.push("house.mortgage.payment_monthly must be a number");
        }
      }
      if (house.property_tax_rate != null && !isNum(house.property_tax_rate))
        issues.push("house.property_tax_rate must be a number");
      if (house.insurance_rate != null && !isNum(house.insurance_rate))
        issues.push("house.insurance_rate must be a number");
      if (house.maintenance_rate != null && !isNum(house.maintenance_rate))
        issues.push("house.maintenance_rate must be a number");
      if (house.hoa_monthly != null && !isNum(house.hoa_monthly)) issues.push("house.hoa_monthly must be a number");
    }
  }

  // ---------- assumptions ----------
  if (d.assumptions == null || !isObj(d.assumptions)) {
    issues.push("assumptions must be an object");
  } else {
    const numericKeys = [
      "inflation",
      "ret",
      "dividend_rate",
      "income_tax",
      "local_tax",
      "cap_gains_tax",
      "start_year",
      "end_year",
      "first_year_fraction",
      "retirement_year",
      "coast_multiple",
      "fi_multiple",
    ] as const;
    for (const k of numericKeys) {
      const v = d.assumptions[k];
      if (v != null && !isNum(v)) issues.push(`assumptions.${k} must be a number`);
    }
  }

  // ---------- drawdown_order ----------
  if (d.drawdown_order != null) {
    if (!isArr(d.drawdown_order) || !d.drawdown_order.every(isStr)) {
      issues.push("drawdown_order must be an array of strings");
    }
  }

  if (issues.length > 0) {
    throw new PlanValidationError(issues);
  }

  return normalizePlan(data as unknown as Plan);
}
