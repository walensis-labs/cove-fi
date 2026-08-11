/**
 * Cove FI engine v0.2 — deterministic annual simulator.
 *
 * Calibration discoveries vs v0:
 *   * PL's contribution waterfall is CASH-FLOW CONSTRAINED: rungs fund in
 *     priority order only while (income - taxes - explicit expenses) lasts.
 *   * Leftover surplus is SPENT (cashFlowDefault: "spend") and lands in the
 *     Expenses metric.  Working years never trigger withdrawals.
 *   * Pretax rungs (401k/HSA) reduce the tax base -> solved iteratively.
 *
 * Ported from cove_fi/engine.py — line-by-line, exact operation order.
 * Parity beats taste here by explicit project decision; do not "improve"
 * any formula, including the trad-withdrawal tax gross-up spiral below.
 */
import {
  type Assumptions,
  COAST,
  IRS_LIMITS_2026,
  normalizePlan,
  type Plan,
  RMD_TABLE,
  type TaxType,
} from "./model.js";

export interface YearRow {
  year: number;
  net_worth: number;
  liquid_net_worth: number;
  income: number;
  expenses: number;
  taxes: number;
  withdrawals: number;
  contributions: number;
}

export function run(plan: Plan, overrides?: Partial<Assumptions>): YearRow[] {
  plan = normalizePlan(plan);
  let a: Assumptions = plan.assumptions;
  if (overrides) {
    a = { ...a, ...overrides };
  }
  const infl = (y: number) => (1 + a.inflation) ** (y - a.start_year);
  const bal: Record<string, number> = {};
  const basis: Record<string, number> = {};
  for (const acc of plan.accounts) {
    bal[acc.name] = acc.balance;
    basis[acc.name] = acc.basis != null ? acc.basis : 0.0;
  }
  const accBy: Record<string, (typeof plan.accounts)[number]> = {};
  for (const acc of plan.accounts) {
    accBy[acc.name] = acc;
  }
  let mortBal = plan.house?.mortgage ? plan.house.mortgage.balance : 0.0;
  let coastYear: number | null = null;
  const spendHist: number[] = [];
  const rows: YearRow[] = [];
  const lastWorkYear = a.retirement_year - 1;

  for (let y = a.start_year; y <= a.end_year; y++) {
    const frac = y === a.start_year ? a.first_year_fraction : 1.0;
    const f = infl(y);
    const age = y - plan.birth_year;
    const row: YearRow = {
      year: y,
      net_worth: 0.0,
      liquid_net_worth: 0.0,
      income: 0.0,
      expenses: 0.0,
      taxes: 0.0,
      withdrawals: 0.0,
      contributions: 0.0,
    };
    const ordRate = a.income_tax + a.local_tax;

    // ---------- income ----------
    let gross = 0.0;
    for (const i of plan.incomes) {
      if (i.start <= y && y <= i.end) {
        gross += i.amount * f * frac;
      }
    }
    let ssGross = 0.0;
    for (const ss of plan.social_security) {
      if (y >= ss.claim_year) {
        ssGross += ss.pia_monthly * 12 * (ss.haircut ?? 1.0) * f;
      }
    }
    row.income = gross + ssGross;

    // ---------- explicit expenses ----------
    let exp = 0.0;
    const funded529: [string, number][] = [];
    for (const e of plan.expenses) {
      if (e.start <= y && y <= e.end) {
        const g = 1 + a.inflation + (e.growth_over_inflation ?? 0);
        let amt = e.amount * (e.nominal_at_start ? g ** (y - e.start) : g ** (y - a.start_year));
        amt *= frac;
        if (e.fund_from) {
          funded529.push([e.fund_from, amt]);
        } else {
          exp += amt;
        }
      }
    }
    const h = plan.house;
    if (h) {
      const hv = h.value * (1 + h.appreciation) ** (y - a.start_year);
      exp += hv * ((h.property_tax_rate ?? 0) + (h.insurance_rate ?? 0) + (h.maintenance_rate ?? 0)) * frac;
      exp += (h.hoa_monthly ?? 0) * 12 * f * frac;
      if (mortBal > 0 && h.mortgage) {
        const nMonths = Math.trunc(12 * frac);
        for (let m = 0; m < nMonths; m++) {
          const interest = (mortBal * h.mortgage.rate) / 12;
          const principal = Math.min(h.mortgage.payment_monthly - interest, mortBal);
          mortBal -= principal;
          exp += interest + principal;
        }
      }
    }

    // 529-funded education: drawn from 529s, not household cash flow
    for (const [name, amt] of funded529) {
      const take = Math.min(bal[name]!, amt);
      bal[name]! -= take;
      row.withdrawals += take;
      exp += Math.max(amt - take, 0.0);
    }

    // ---------- working years: iterative taxes + cash-flow waterfall ----
    const limits: Record<string, number> = {};
    for (const [k, v] of Object.entries(IRS_LIMITS_2026)) {
      limits[k] = v * f;
    }
    const inCoast = coastYear !== null && y > coastYear;
    let pretax = 0.0;
    let contribs: Record<string, number> = {};
    let matches: Record<string, number> = {};
    let taxes: number;
    if (y <= lastWorkYear) {
      for (let iter = 0; iter < 4; iter++) {
        taxes = Math.max(gross - pretax, 0.0) * ordRate;
        let available = gross - taxes - exp;
        const newContribs: Record<string, number> = {};
        const newMatches: Record<string, number> = {};
        let newPretax = 0.0;
        for (const c of plan.contributions) {
          if ((c.end === COAST && inCoast) || (c.start === COAST && !inCoast)) {
            continue;
          }
          const cs = c.start !== COAST ? c.start : (coastYear as number) + 1;
          const ce = c.end !== COAST ? c.end : lastWorkYear;
          if (!(cs <= y && y <= Math.min(ce, lastWorkYear))) {
            continue;
          }
          let want: number;
          if (c.to_limit && c.annual_limit_key) {
            want = limits[c.annual_limit_key]!;
          } else if (c.pct_of_income != null) {
            want = Math.min(
              c.pct_of_income * 225_000 * f,
              c.annual_limit_key != null ? (limits[c.annual_limit_key] ?? 1e18) : 1e18,
            );
          } else {
            want = c.amount! * f;
          }
          want *= frac;
          const amt = Math.max(Math.min(want, available), 0.0);
          available -= amt;
          let m = 0.0;
          if (c.employer_match_pct) {
            m =
              frac < 1
                ? Math.min(c.employer_match_pct * 225_000 * f, amt) * frac
                : Math.min(c.employer_match_pct * 225_000 * f, want);
            m = amt > 0 ? m : 0.0;
          }
          if (c.employer_match_flat) {
            m = amt > 0 ? c.employer_match_flat * f * frac : 0.0;
          }
          const key = c.account;
          newContribs[key] = (newContribs[key] ?? 0.0) + amt;
          newMatches[key] = (newMatches[key] ?? 0.0) + m;
          if (c.pretax) {
            newPretax += amt;
          }
        }
        if (Math.abs(newPretax - pretax) < 1.0) {
          contribs = newContribs;
          matches = newMatches;
          pretax = newPretax;
          break;
        }
        contribs = newContribs;
        matches = newMatches;
        pretax = newPretax;
      }
      taxes = Math.max(gross - pretax, 0.0) * ordRate;
      const contribSum = Object.values(contribs).reduce((s, v) => s + v, 0);
      const surplus = gross - taxes - exp - contribSum;
      if (surplus > 0) {
        exp += surplus; // cashFlowDefault: "spend"
      }
      for (const [k, v] of Object.entries(contribs)) {
        bal[k]! += v + (matches[k] ?? 0.0);
        if (accBy[k]!.tax === "taxable") {
          basis[k]! += v;
        }
      }
      row.contributions = contribSum;
    } else {
      taxes = 0.0;
    }

    // dividends on taxable balances (qualified, taxed at cap-gains)
    let div = 0.0;
    for (const [n, acc] of Object.entries(accBy)) {
      if (acc.tax === "taxable") {
        div += bal[n]!;
      }
    }
    div *= a.dividend_rate * frac;
    taxes += div * a.cap_gains_tax;

    // ---------- retirement: fund the gap ----------
    let tradTaken = 0.0;
    if (y > lastWorkYear) {
      for (const ss of plan.social_security) {
        if (y >= ss.claim_year) {
          taxes += ss.pia_monthly * 12 * (ss.haircut ?? 1.0) * f * (ss.taxable_fraction ?? 0.85) * ordRate;
        }
      }
      const need = exp + taxes - row.income;
      const order: TaxType[] = ["taxable", "hsa", "trad", "roth", "cash"];
      let remaining = Math.max(need, 0.0);
      for (const tt of order) {
        if (remaining <= 0) break;
        for (const acc of plan.accounts) {
          if (acc.tax !== tt || remaining <= 0 || bal[acc.name]! <= 0) {
            continue;
          }
          const take = Math.min(bal[acc.name]!, remaining);
          let extra = 0.0;
          if (tt === "trad") {
            extra = take * ordRate;
            tradTaken += take;
          } else if (tt === "taxable") {
            const gain = Math.max(1 - basis[acc.name]! / bal[acc.name]!, 0.0);
            extra = take * gain * a.cap_gains_tax;
            basis[acc.name]! *= 1 - take / bal[acc.name]!;
          }
          bal[acc.name]! -= take;
          remaining -= take;
          remaining += extra;
          taxes += extra;
          row.withdrawals += take;
        }
      }
    }

    // RMDs net of trad withdrawals already taken
    if (age >= 73) {
      const divisor = RMD_TABLE[Math.min(age, 100)] ?? 6.4;
      let tradTotal = 0.0;
      for (const acc of plan.accounts) {
        if (acc.rmd) {
          tradTotal += bal[acc.name]!;
        }
      }
      const rmd = divisor ? tradTotal / divisor : 0.0;
      let forced = Math.max(rmd - tradTaken, 0.0);
      for (const acc of plan.accounts) {
        if (forced <= 0) break;
        if (acc.rmd && bal[acc.name]! > 0) {
          const take = Math.min(bal[acc.name]!, forced);
          bal[acc.name]! -= take;
          forced -= take;
          taxes += take * ordRate;
          row.withdrawals += take;
          // after-tax RMD excess: spent (cashFlowDefault)
        }
      }
    }

    row.taxes = taxes;
    row.expenses = exp;

    // ---------- growth ----------
    for (const acc of plan.accounts) {
      const r = acc.growth != null ? acc.growth : a.ret;
      bal[acc.name]! *= 1 + r * frac;
    }

    let liquid = 0.0;
    let il529 = 0.0;
    for (const acc of plan.accounts) {
      if (acc.liquid) {
        liquid += bal[acc.name]!;
      } else {
        il529 += bal[acc.name]!;
      }
    }
    const hv2 = h ? h.value * (1 + h.appreciation) ** (y - a.start_year + 1) : 0.0;
    row.liquid_net_worth = liquid - mortBal;
    row.net_worth = liquid + il529 + hv2 - mortBal;
    rows.push(row);

    spendHist.push(row.expenses);
    const tail = spendHist.slice(-3);
    const avg = tail.reduce((s, v) => s + v, 0) / Math.min(spendHist.length, 3);
    if (coastYear === null && row.liquid_net_worth >= 4 * avg) {
      coastYear = y;
    }
  }

  return rows;
}
