/**
 * Cove FI engine v0.2 — deterministic annual simulator.
 *
 * Core semantics (full detail in docs/SEMANTICS.md):
 *   * The contribution waterfall is CASH-FLOW CONSTRAINED: rungs fund in
 *     priority order only while (income - taxes - explicit expenses) lasts.
 *     No rung ever triggers a withdrawal from another account to fund
 *     itself.
 *   * Leftover surplus is SPENT (cashFlowDefault: "spend") and lands in the
 *     Expenses metric. Working years never trigger withdrawals.
 *   * Pretax rungs (401k/HSA) reduce the tax base -> solved iteratively.
 *   * Retirement drawdown order is fixed: taxable -> hsa -> trad -> roth
 *     -> cash, with basis-proportional gains on taxable withdrawals.
 *
 * Do not "improve" a formula here without updating docs/SEMANTICS.md and
 * its guarding tests in the same change — see docs/VALIDATION.md for how
 * this engine's behavior is checked.
 */
import {
  type Account,
  type Assumptions,
  COAST,
  IRS_LIMITS_2026,
  normalizePlan,
  type Plan,
  resolveRet,
  RETIREMENT,
  RMD_TABLE,
  type TaxType,
} from "./model.js";

// A cash account's resolved growth rate is taxed as ordinary income only
// when its APPLIED rate actually comes from the new per-account/per-class
// fields — per-account `ret` or plan-level `class_returns.cash`. `growth`
// (legacy) keeps absolute precedence in the resolution chain (see the
// `growthRate` comment below), so a cash account carrying `growth` is
// NEVER cash-taxed, even in a plan that has otherwise opted into
// `class_returns.cash` — its rate doesn't come from the new fields, full
// stop. This preserves 0.3.0 behavior exactly for every growth-carrying
// cash account, opted-in plan or not.
function cashTaxGated(acc: Account, a: Assumptions): boolean {
  return acc.tax === "cash" && acc.growth == null && (acc.ret != null || a.class_returns?.cash != null);
}

export interface YearRow {
  year: number;
  net_worth: number;
  liquid_net_worth: number;
  // 0.5.0: sum of earmarked accounts' balances this year (0 when the plan
  // has none). Earmarked accounts are EXCLUDED from `net_worth` — they're
  // saved toward a specific goal (e.g. a house fund), not general-purpose
  // net worth — but included here so callers can still see the money.
  // Legacy `liquid:false` non-earmarked accounts (e.g. a 529) are
  // unaffected: they stay inside `net_worth`, exactly as before 0.5.0.
  earmarked_net_worth: number;
  income: number;
  expenses: number;
  taxes: number;
  withdrawals: number;
  contributions: number;
}

export interface YearRates {
  year: number;
  ret: number;
  inflation: number;
  // Historical T-bill rate for the SAME sampled year as `ret`/`inflation` —
  // additive, so a schedule that omits it (any hand-built or pre-0.4.0
  // rates array) falls back to `ret` for cash-class accounts, unchanged.
  // Populated by montecarlo.ts's sampleSchedule() so a cash sleeve grows
  // along a path correlated with the same sampled market years, instead of
  // riding the sp500 path like every other account class.
  cash_ret?: number;
}

// 0.6.0: opt-in per-year engine detail — the substrate the cash-flow audit
// tool renders. Populated ONLY when runWithMeta is called with
// `{ detail: true }`; every YearRow total above is computed exactly as
// before regardless of this flag (see the accumulator comments in the year
// loop for how each bucket maps back onto `taxes`, etc.).
//
// RECONCILIATION IS THE POINT of this shape (fix round after initial
// review): each of incomes/expenses/contributions/withdrawals sums EXACTLY
// (bit-for-bit, not approximately) to its corresponding row total — that's
// what lets the audit tool trust the breakdown instead of re-deriving it.
// Zero-amount entries are skipped in all four arrays (a rung squeezed to $0
// by exhausted cash flow, or a $0 withdrawal, is noise for a human-readable
// audit, not a reconciliation requirement — omitting a term whose value is
// exactly 0 never changes a sum).
export interface YearDetail {
  year: number;
  // Every plan.incomes line active this year, in plan order, at its grossed
  // gross amount (amount x inflation factor x frac) — the same `amt` the
  // engine adds into `gross` — PLUS one synthetic "Social Security" line
  // carrying that year's total SS (all claimants aggregated, the same
  // `ssGross` added into row.income) when nonzero. sum(incomes[].amount)
  // equals row.income exactly.
  incomes: { name: string; amount: number }[];
  // A CASH-FLOW ledger — every entry's `amount` is money that actually hit
  // `exp` (row.expenses) this year, so sum(expenses[].amount) equals
  // row.expenses exactly. Every plan.expenses line active this year, in
  // plan order, PLUS synthetic lines for the household costs the engine
  // folds into `exp` without a plan.expenses entry: "House (property tax,
  // insurance, maintenance, HOA)" (combined house carrying cost), "Mortgage
  // (P&I)" (that year's principal+interest), and "Discretionary
  // (unallocated surplus)" (the cashFlowDefault: "spend" plug, when > 0).
  // Those three are synthetic (fund_from: null) and omitted when 0, like
  // every other zero-amount line.
  //
  // For a NON-fund_from line, `amount` is the full plan.expenses amount,
  // funded_from_account is 0, and funded_from_cash_flow === amount (100%
  // cash flow, nothing drawn from an account).
  //
  // For a fund_from (529-funded) plan.expenses line, `amount` (and
  // funded_from_cash_flow, always equal) is ONLY the shortfall that fell
  // through to household cash flow — the portion the account covered NEVER
  // touched `exp`, so it's excluded here (it's a `detail.withdrawals` entry
  // instead, for that same account/year). A fully-covered fund_from
  // expense therefore contributes 0 to this array and is omitted, even
  // though the draw itself is visible in `withdrawals`. funded_from_account
  // reports how much of THIS expense the account covered, for context
  // (cross-reference `withdrawals` for the draw itself) — it is
  // informational and does NOT sum into `amount` (that would double-count
  // money that never hit cash flow, the case the audit tool flags).
  expenses: {
    name: string;
    amount: number;
    fund_from?: string | null;
    funded_from_account: number;
    funded_from_cash_flow: number;
  }[];
  // One entry per active, non-zero contribution rung for the year (in plan
  // order, from the FINAL converged iteration of the pretax waterfall).
  // sum(amount) equals row.contributions exactly.
  contributions: { account: string; name?: string; amount: number; match: number }[];
  // One entry per actual, non-zero withdrawal this year: 529 draws, the
  // retirement drawdown waterfall, and RMDs. sum(amount) equals
  // row.withdrawals exactly.
  withdrawals: { account: string; amount: number }[];
  // The four components the engine sums into row.taxes. `ordinary` and
  // `capital_gains` are RATE buckets, not source buckets: the
  // trad-withdrawal gross-up tax and the RMD tax are both taxed at the
  // ordinary rate, so they're folded into `ordinary` alongside the
  // working-years ordinary income tax; the taxable-account withdrawal's
  // basis-proportional gains tax is taxed at the SAME cap_gains_tax rate as
  // the dividend tax, so it's folded into `capital_gains` alongside the
  // dividend tax itself. `cash_interest` and `social_security` are each
  // exactly one accumulator in the engine. The four always sum to
  // row.taxes exactly.
  taxes: { ordinary: number; capital_gains: number; cash_interest: number; social_security: number };
}

export interface RunResult {
  rows: YearRow[];
  coast_year: number | null;
  detail?: YearDetail[];
}

/**
 * Pure amortization replay — mirrors the engine's monthly mortgage loop
 * exactly (12 payments/yr; the plan's own first_year_fraction truncates the
 * first year's payment count via Math.trunc(12 * frac)). Returns the
 * balance remaining after `uptoYear`'s payments and the interest+principal
 * paid during `uptoYear` specifically (0 for both once the loan is
 * retired). `uptoYear < startYear` returns the loan untouched.
 */
function replayMortgage(
  house: Plan["house"],
  startYear: number,
  firstYearFraction: number,
  uptoYear: number,
): { balance: number; paidInYear: number } {
  if (!house?.mortgage) return { balance: 0, paidInYear: 0 };
  let bal = house.mortgage.balance;
  let paidInYear = 0;
  for (let y = startYear; y <= uptoYear; y++) {
    const frac = y === startYear ? firstYearFraction : 1.0;
    paidInYear = 0;
    if (bal > 0) {
      const nMonths = Math.trunc(12 * frac);
      for (let m = 0; m < nMonths; m++) {
        const interest = (bal * house.mortgage.rate) / 12;
        const principal = Math.min(house.mortgage.payment_monthly - interest, bal);
        bal -= principal;
        paidInYear += interest + principal;
      }
    }
  }
  return { balance: bal, paidInYear };
}

/**
 * Pure amortization replay of the plan's mortgage (if any) through `year`,
 * mirroring the engine's monthly loop exactly — no dependency on a run()
 * call. Used both by `coastTargetAtRetirement` (that year's P&I) and by
 * the in-loop coast test (netting the projected remaining balance at
 * retirement_year out of projected liquid balances).
 *
 * `assumptions` defaults to the plan's own (normalized) assumptions, but
 * callers driving an overridden run (e.g. runWithMeta with a scenario's
 * merged `a`) MUST pass that merged `a` explicitly — otherwise, if
 * start_year or first_year_fraction were overridden, this replay would
 * start from the plan's ORIGINAL values while the rest of the run (whose
 * mortgage amortization is driven by the merged `a.start_year`) uses the
 * override, silently desyncing the two.
 */
export function mortgageBalanceAt(plan: Plan, year: number, assumptions?: Assumptions): number {
  const p = normalizePlan(plan);
  const a = assumptions ?? p.assumptions;
  return replayMortgage(p.house, a.start_year, a.first_year_fraction, year).balance;
}

/**
 * True-CoastFIRE target: fi_multiple x the household's annual spending in
 * retirement_year (R = a.retirement_year), computed from CONSTANT rates
 * (a.inflation, house appreciation) via closed-form powers — this is an
 * EXPECTATIONS test, so it never reads the trial's sampled rates path even
 * when one is active elsewhere in the same run.
 *
 * Mirrors engine's own expense/house-cost formulas exactly:
 *   - explicit expenses active at R, grown per their convention: today's-$
 *     items by (1+inflation+growth_over_inflation)^(R-start_year);
 *     nominal_at_start items by the SAME rate ^(R-e.start) — this single
 *     exponent form is correct whether e.start falls before OR after
 *     start_year (the engine's running expGrow multiplier seeds pre-horizon
 *     items at g^(start_year-e.start-1) and then multiplies every year
 *     start_year..R inclusive since e.start < start_year <= every such
 *     year, which telescopes to exactly g^(R-e.start)).
 *   - fund_from (529-funded) expenses excluded, because they're excluded
 *     from the engine's own `exp` too whenever the 529 covers them in
 *     full — that's the common case this closed form can express without
 *     replaying the 529's own balance/contribution history to R.
 *     LIMITATION: if the 529 would instead be DEPLETED by R, the engine's
 *     per-year loop pushes the shortfall (`amt - take`) into `exp` (real
 *     household cash flow that year) — this closed form has no way to
 *     know that in advance, so it always excludes the full fund_from
 *     amount regardless, understating the target for a plan whose 529
 *     runs dry before retirement. See coast.test.ts's "fund_from" describe
 *     block for a pin of this documented (not fixed) behavior.
 *   - house costs at R: property/insurance/maintenance on appreciated
 *     value, HOA inflated, and that year's mortgage P&I (0 once the loan
 *     is retired by R) — all frac-adjusted only when R === start_year,
 *     exactly like the engine's per-year `frac`.
 */
export function coastTargetAtRetirement(plan: Plan, a: Assumptions): number {
  const p = normalizePlan(plan);
  const R = a.retirement_year;
  const frac = R === a.start_year ? a.first_year_fraction : 1.0;
  let spend = 0.0;
  for (const e of p.expenses) {
    if (e.fund_from) continue;
    if (e.start <= R && R <= e.end) {
      const g = 1 + a.inflation + (e.growth_over_inflation ?? 0);
      const exponent = e.nominal_at_start ? R - e.start : R - a.start_year;
      spend += e.amount * g ** exponent * frac;
    }
  }
  const h = p.house;
  if (h) {
    const hv = h.value * (1 + h.appreciation) ** (R - a.start_year);
    spend += hv * ((h.property_tax_rate ?? 0) + (h.insurance_rate ?? 0) + (h.maintenance_rate ?? 0)) * frac;
    const infFactor = (1 + a.inflation) ** (R - a.start_year);
    spend += (h.hoa_monthly ?? 0) * 12 * infFactor * frac;
    spend += replayMortgage(h, a.start_year, a.first_year_fraction, R).paidInYear;
  }
  return a.fi_multiple * spend;
}

export function run(plan: Plan, overrides?: Partial<Assumptions>, rates?: YearRates[]): YearRow[] {
  return runWithMeta(plan, overrides, rates).rows;
}

export function runWithMeta(
  plan: Plan,
  overrides?: Partial<Assumptions>,
  rates?: YearRates[],
  opts?: { detail?: boolean },
): RunResult {
  plan = normalizePlan(plan);
  let a: Assumptions = plan.assumptions;
  if (overrides) {
    a = { ...a, ...overrides };
  }
  // 0.6.0: detail is strictly opt-in — when falsy, `details` stays
  // undefined and every push below is guarded by `wantDetail`, so no
  // YearDetail object/array is ever allocated.
  const wantDetail = opts?.detail === true;
  const details: YearDetail[] | undefined = wantDetail ? [] : undefined;
  // income.end === RETIREMENT tracks the scenario's (possibly overridden)
  // retirement_year rather than a fixed year — resolved here, under
  // EFFECTIVE assumptions, so the rest of run() never sees the sentinel.
  const incomes = plan.incomes.map((i) => (i.end === RETIREMENT ? { ...i, end: a.retirement_year - 1 } : i));
  let rateFor: (y: number) => { ret: number; inflation: number; cash_ret?: number };
  if (rates) {
    const byYear = new Map<number, YearRates>();
    for (const r of rates) {
      byYear.set(r.year, r);
    }
    for (let y = a.start_year; y <= a.end_year; y++) {
      const r = byYear.get(y);
      if (!r) {
        throw new Error(`rates schedule must cover ${a.start_year}..${a.end_year}`);
      }
      if (!Number.isFinite(r.ret) || !Number.isFinite(r.inflation)) {
        throw new Error("rates schedule contains non-finite values");
      }
      if (r.cash_ret != null && !Number.isFinite(r.cash_ret)) {
        throw new Error("rates schedule contains non-finite values");
      }
    }
    rateFor = (y: number) => {
      const r = byYear.get(y)!;
      return { ret: r.ret, inflation: r.inflation, cash_ret: r.cash_ret };
    };
  } else {
    rateFor = () => ({ ret: a.ret, inflation: a.inflation });
  }
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
  const rows: YearRow[] = [];
  // Coast expectations test — target, netted mortgage balance, and the
  // per-account rate used to project balances forward are ALL y-invariant
  // (R is fixed, and the projection deliberately ignores any rates
  // schedule), so every one of them is computed once here rather than
  // inside the year loop.
  const coastTarget = coastTargetAtRetirement(plan, a);
  const coastMortgageBalanceAtR = mortgageBalanceAt(plan, a.retirement_year, a);
  const coastGrowthRate: Record<string, number> = {};
  for (const acc of plan.accounts) {
    coastGrowthRate[acc.name] = acc.growth ?? resolveRet(acc, a);
  }
  const lastWorkYear = a.retirement_year - 1;
  let f = 1.0;
  const expGrow = plan.expenses.map((e) =>
    e.nominal_at_start && e.start < a.start_year
      ? (1 + a.inflation + (e.growth_over_inflation ?? 0)) ** (a.start_year - e.start - 1)
      : 1.0,
  );

  for (let y = a.start_year; y <= a.end_year; y++) {
    if (y > a.start_year) {
      f *= 1 + rateFor(y).inflation;
    }
    plan.expenses.forEach((e, i) => {
      const gy = 1 + rateFor(y).inflation + (e.growth_over_inflation ?? 0);
      if (y > (e.nominal_at_start ? e.start : a.start_year)) {
        expGrow[i]! *= gy;
      }
    });
    const frac = y === a.start_year ? a.first_year_fraction : 1.0;
    const age = y - plan.birth_year;
    const row: YearRow = {
      year: y,
      net_worth: 0.0,
      liquid_net_worth: 0.0,
      earmarked_net_worth: 0.0,
      income: 0.0,
      expenses: 0.0,
      taxes: 0.0,
      withdrawals: 0.0,
      contributions: 0.0,
    };
    let yearDetail: YearDetail | undefined;
    if (wantDetail) {
      yearDetail = {
        year: y,
        incomes: [],
        expenses: [],
        contributions: [],
        withdrawals: [],
        taxes: { ordinary: 0.0, capital_gains: 0.0, cash_interest: 0.0, social_security: 0.0 },
      };
    }
    const ordRate = a.income_tax + a.local_tax;

    // Resolved growth rate per account for this year: the legacy `growth`
    // field keeps absolute precedence over everything, always. Otherwise:
    // when a `rates` schedule is present, sampled paths are dominant —
    // the schedule's ret wins over both acc.ret and class_returns (MC
    // scenario shocks must not be short-circuited by a per-account/class
    // override) — EXCEPT cash-class accounts (acc.tax === "cash"), which
    // follow the schedule's cash_ret (a correlated T-bill path, sampled
    // from the SAME historical year as ret/inflation) instead of the
    // sp500-derived ret, falling back to yr.ret when the schedule was
    // built before cash_ret existed. Only in the no-schedule case does
    // resolveRet()'s account -> class_returns -> plan-default chain apply.
    // Computed once and reused by both the cash-tax gate below and the
    // growth loop at the end of the year, so tax and growth never drift.
    const yr = rateFor(y);
    const growthRate: Record<string, number> = {};
    for (const acc of plan.accounts) {
      const scheduledRate = acc.tax === "cash" ? (yr.cash_ret ?? yr.ret) : yr.ret;
      growthRate[acc.name] = acc.growth ?? (rates ? scheduledRate : resolveRet(acc, a));
    }

    // ---------- income ----------
    let gross = 0.0;
    let taxableGross = 0.0;
    for (const i of incomes) {
      if (i.start <= y && y <= i.end) {
        const amt = i.amount * f * frac;
        gross += amt;
        if (i.taxable !== false) {
          taxableGross += amt;
        }
        if (wantDetail && amt !== 0) {
          yearDetail!.incomes.push({ name: i.name, amount: amt });
        }
      }
    }
    let ssGross = 0.0;
    for (const ss of plan.social_security) {
      if (y >= ss.claim_year) {
        ssGross += ss.pia_monthly * 12 * (ss.haircut ?? 1.0) * f;
      }
    }
    // One synthetic line for ALL claimants combined — matches exactly the
    // same `ssGross` added into row.income below, so
    // sum(incomes[].amount) === row.income (append-only: gross's own
    // running sum is untouched, this is simply one more term added last,
    // in the SAME order as `gross + ssGross`).
    if (wantDetail && ssGross !== 0) {
      yearDetail!.incomes.push({ name: "Social Security", amount: ssGross });
    }
    row.income = gross + ssGross;

    // ---------- explicit expenses ----------
    let exp = 0.0;
    // `detail.expenses` is a CASH-FLOW ledger (it reconciles to
    // row.expenses, a cash-flow metric) — a fund_from line's `amount` is
    // pushed below, once the real split is known, as ONLY the fallthrough
    // that actually hit cash flow (never the full nominal obligation: the
    // account-covered portion never touched `exp` at all, exactly like the
    // engine's own "drawn from 529s, not household cash flow" comment
    // below says). The tuple carries the expense's name/fund_from straight
    // through to that later push — no parallel detail array to misalign.
    const funded529: [account: string, amt: number, name: string, fundFrom: string][] = [];
    plan.expenses.forEach((e, i) => {
      if (e.start <= y && y <= e.end) {
        let amt = e.amount * expGrow[i]!;
        amt *= frac;
        if (e.fund_from) {
          funded529.push([e.fund_from, amt, e.name, e.fund_from]);
        } else {
          exp += amt;
          if (wantDetail && amt !== 0) {
            yearDetail!.expenses.push({
              name: e.name,
              amount: amt,
              fund_from: e.fund_from ?? null,
              funded_from_account: 0,
              funded_from_cash_flow: amt,
            });
          }
        }
      }
    });
    const h = plan.house;
    if (h) {
      const hv = h.value * (1 + h.appreciation) ** (y - a.start_year);
      // `exp` accumulates via the SAME two separate `+=` as always — byte-
      // for-byte untouched, so golden compatibility is unaffected. The
      // audit-only "House ..." amount is instead recovered as a before/
      // after DELTA of `exp` itself (not a fresh houseTax+houseHoa
      // recomputation): floating-point addition is not associative, so
      // (R+taxVal)+hoaVal (what `exp` actually computes) can differ from
      // R+(taxVal+hoaVal) (an independent fresh sum) at the last bit for a
      // nonzero running total R — confirmed empirically against the golden
      // fixture. The delta form is exact here because Sterbenz's lemma
      // applies (the running total is never smaller than half the total
      // after adding a single year's house costs for any realistic plan),
      // so `expBeforeHouse + (exp - expBeforeHouse) === exp` bit-for-bit.
      const expBeforeHouse = exp;
      exp += hv * ((h.property_tax_rate ?? 0) + (h.insurance_rate ?? 0) + (h.maintenance_rate ?? 0)) * frac;
      exp += (h.hoa_monthly ?? 0) * 12 * f * frac;
      const houseCarrying = exp - expBeforeHouse;
      if (wantDetail && houseCarrying !== 0) {
        yearDetail!.expenses.push({
          name: "House (property tax, insurance, maintenance, HOA)",
          amount: houseCarrying,
          fund_from: null,
          funded_from_account: 0,
          funded_from_cash_flow: houseCarrying,
        });
      }
      // Same delta technique for the mortgage's P&I: `exp` still gains
      // `interest + principal` once per month, in the SAME loop, untouched.
      let mortgagePI = 0.0;
      if (mortBal > 0 && h.mortgage) {
        const expBeforeMortgage = exp;
        const nMonths = Math.trunc(12 * frac);
        for (let m = 0; m < nMonths; m++) {
          const interest = (mortBal * h.mortgage.rate) / 12;
          const principal = Math.min(h.mortgage.payment_monthly - interest, mortBal);
          mortBal -= principal;
          exp += interest + principal;
        }
        mortgagePI = exp - expBeforeMortgage;
      }
      if (wantDetail && mortgagePI !== 0) {
        yearDetail!.expenses.push({
          name: "Mortgage (P&I)",
          amount: mortgagePI,
          fund_from: null,
          funded_from_account: 0,
          funded_from_cash_flow: mortgagePI,
        });
      }
    }

    // 529-funded education: drawn from 529s, not household cash flow
    for (let fi = 0; fi < funded529.length; fi++) {
      const [accountName, amt, expenseName, fundFrom] = funded529[fi]!;
      const take = Math.min(bal[accountName]!, amt);
      bal[accountName]! -= take;
      row.withdrawals += take;
      const fallthrough = Math.max(amt - take, 0.0);
      exp += fallthrough;
      if (wantDetail && take !== 0) {
        yearDetail!.withdrawals.push({ account: accountName, amount: take });
      }
      // `amount` here is the fallthrough ONLY — the account-covered part
      // never hit cash flow, so it's excluded from this cash-flow ledger
      // (it's already visible above, in `withdrawals`). A fully-covered
      // fund_from expense (fallthrough === 0) is correctly omitted here.
      if (wantDetail && fallthrough !== 0) {
        yearDetail!.expenses.push({
          name: expenseName,
          amount: fallthrough,
          fund_from: fundFrom,
          funded_from_account: take,
          funded_from_cash_flow: fallthrough,
        });
      }
    }

    // ---------- working years: iterative taxes + cash-flow waterfall ----
    const limits: Record<string, number> = {};
    for (const [k, v] of Object.entries(IRS_LIMITS_2026)) {
      limits[k] = v * f;
    }
    const inCoast = coastYear !== null && y > coastYear;
    let pretax = 0.0;
    let contribs: Map<string, number> = new Map();
    let matches: Map<string, number> = new Map();
    let contribsDetail: YearDetail["contributions"] | undefined;
    let taxes: number;
    if (y <= lastWorkYear) {
      for (let iter = 0; iter < 4; iter++) {
        taxes = Math.max(taxableGross - pretax, 0.0) * ordRate;
        let available = gross - taxes - exp;
        const newContribs: Map<string, number> = new Map();
        const newMatches: Map<string, number> = new Map();
        const newContribsDetail: YearDetail["contributions"] | undefined = wantDetail ? [] : undefined;
        let newPretax = 0.0;
        for (const c of plan.contributions) {
          if ((c.end === COAST && inCoast) || (c.start === COAST && !inCoast)) {
            continue;
          }
          // 0.5.0: a plain hard_end caps this rung independent of `end`
          // (including a COAST-end rung) — whichever ends first governs.
          if (c.hard_end != null && y > c.hard_end) {
            continue;
          }
          const cs = c.start !== COAST ? c.start : (coastYear as number) + 1;
          const ce = c.end !== COAST ? c.end : lastWorkYear;
          if (!(cs <= y && y <= Math.min(ce, lastWorkYear))) {
            continue;
          }
          let want: number;
          if (c.to_limit && c.annual_limit_key) {
            want = limits[c.annual_limit_key]! * frac;
          } else if (c.pct_of_income != null) {
            want = Math.min(
              c.pct_of_income * gross,
              c.annual_limit_key != null ? (limits[c.annual_limit_key] ?? 1e18) : 1e18,
            );
          } else {
            want = c.amount! * f * frac;
          }
          const amt = Math.max(Math.min(want, available), 0.0);
          available -= amt;
          let m = 0.0;
          if (c.employer_match_pct) {
            m = amt > 0 ? Math.min(amt, c.employer_match_pct * gross) : 0.0;
          }
          if (c.employer_match_flat) {
            m = amt > 0 ? c.employer_match_flat * f * frac : 0.0;
          }
          const key = c.account;
          newContribs.set(key, (newContribs.get(key) ?? 0.0) + amt);
          newMatches.set(key, (newMatches.get(key) ?? 0.0) + m);
          if (wantDetail && amt !== 0) {
            newContribsDetail!.push({ account: c.account, name: c.name, amount: amt, match: m });
          }
          if (c.pretax) {
            newPretax += amt;
          }
        }
        if (Math.abs(newPretax - pretax) < 1.0) {
          contribs = newContribs;
          matches = newMatches;
          pretax = newPretax;
          contribsDetail = newContribsDetail;
          break;
        }
        contribs = newContribs;
        matches = newMatches;
        pretax = newPretax;
        contribsDetail = newContribsDetail;
      }
      taxes = Math.max(taxableGross - pretax, 0.0) * ordRate;
      if (wantDetail) {
        yearDetail!.taxes.ordinary += taxes;
      }
      let contribSum = 0.0;
      for (const v of contribs.values()) {
        contribSum += v;
      }
      const surplus = gross - taxes - exp - contribSum;
      if (surplus > 0) {
        exp += surplus; // cashFlowDefault: "spend"
        if (wantDetail) {
          yearDetail!.expenses.push({
            name: "Discretionary (unallocated surplus)",
            amount: surplus,
            fund_from: null,
            funded_from_account: 0,
            funded_from_cash_flow: surplus,
          });
        }
      }
      for (const [k, v] of contribs) {
        bal[k]! += v + (matches.get(k) ?? 0.0);
        if (accBy[k]!.tax === "taxable") {
          basis[k]! += v;
        }
      }
      row.contributions = contribSum;
      if (wantDetail) {
        yearDetail!.contributions = contribsDetail!;
      }
    } else {
      taxes = 0.0;
    }

    // dividends on taxable balances (qualified, taxed at cap-gains)
    let div = 0.0;
    for (const acc of plan.accounts) {
      if (acc.tax === "taxable") {
        div += bal[acc.name]!;
      }
    }
    div = div * a.dividend_rate * frac;
    const dividendTax = div * a.cap_gains_tax;
    taxes += dividendTax;
    if (wantDetail) {
      yearDetail!.taxes.capital_gains += dividendTax;
    }

    // gated cash-interest taxation: pre-growth balance x resolved rate,
    // taxed as ordinary income, in every year (working and retirement) —
    // interest is income the household owes tax on now.
    for (const acc of plan.accounts) {
      if (cashTaxGated(acc, a)) {
        const cashInterestTax = bal[acc.name]! * growthRate[acc.name]! * frac * ordRate;
        taxes += cashInterestTax;
        if (wantDetail) {
          yearDetail!.taxes.cash_interest += cashInterestTax;
        }
      }
    }

    // ---------- retirement: fund the gap ----------
    let tradTaken = 0.0;
    if (y > lastWorkYear) {
      for (const ss of plan.social_security) {
        if (y >= ss.claim_year) {
          const ssTax = ss.pia_monthly * 12 * (ss.haircut ?? 1.0) * f * (ss.taxable_fraction ?? 0.85) * ordRate;
          taxes += ssTax;
          if (wantDetail) {
            yearDetail!.taxes.social_security += ssTax;
          }
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
          // 0.5.0: earmarked accounts are saved toward a specific goal, not
          // general-purpose retirement spending — the discretionary
          // waterfall must never raid one to cover a cash-flow gap. RMDs
          // (below, forced by law) are NOT gated by this — see model.ts's
          // earmarked doc comment.
          if (acc.earmarked) {
            continue;
          }
          const take = Math.min(bal[acc.name]!, remaining);
          let extra = 0.0;
          if (tt === "trad") {
            // Ordinary-rate gross-up on a trad withdrawal — IS ordinary
            // income tax, so it's folded into the `ordinary` bucket.
            extra = take * ordRate;
            tradTaken += take;
            if (wantDetail) {
              yearDetail!.taxes.ordinary += extra;
            }
          } else if (tt === "taxable") {
            const gain = Math.max(1 - basis[acc.name]! / bal[acc.name]!, 0.0);
            // Basis-proportional gains on a taxable withdrawal, taxed at
            // cap_gains_tax — the SAME rate as the dividend tax, so it's
            // folded into the `capital_gains` bucket (see YearDetail.taxes
            // doc).
            extra = take * gain * a.cap_gains_tax;
            basis[acc.name]! *= 1 - take / bal[acc.name]!;
            if (wantDetail) {
              yearDetail!.taxes.capital_gains += extra;
            }
          }
          bal[acc.name]! -= take;
          remaining -= take;
          remaining += extra;
          taxes += extra;
          row.withdrawals += take;
          if (wantDetail && take !== 0) {
            yearDetail!.withdrawals.push({ account: acc.name, amount: take });
          }
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
          // RMD tax is ordinary-income tax — folded into the `ordinary`
          // bucket (see YearDetail.taxes doc).
          const rmdTax = take * ordRate;
          taxes += rmdTax;
          row.withdrawals += take;
          if (wantDetail) {
            yearDetail!.taxes.ordinary += rmdTax;
            if (take !== 0) {
              yearDetail!.withdrawals.push({ account: acc.name, amount: take });
            }
          }
          // after-tax RMD excess: spent (cashFlowDefault)
        }
      }
    }

    row.taxes = taxes;
    row.expenses = exp;

    // ---------- growth ----------
    for (const acc of plan.accounts) {
      bal[acc.name]! *= 1 + growthRate[acc.name]! * frac;
    }

    let liquid = 0.0;
    let il529 = 0.0;
    let earmarked = 0.0;
    for (const acc of plan.accounts) {
      if (acc.liquid) {
        liquid += bal[acc.name]!;
      } else if (acc.earmarked) {
        earmarked += bal[acc.name]!;
      } else {
        il529 += bal[acc.name]!;
      }
    }
    const hv2 = h ? h.value * (1 + h.appreciation) ** (y - a.start_year + 1) : 0.0;
    row.liquid_net_worth = liquid - mortBal;
    row.net_worth = liquid + il529 + hv2 - mortBal;
    row.earmarked_net_worth = earmarked;
    rows.push(row);
    if (wantDetail) {
      details!.push(yearDetail!);
    }

    // True-CoastFIRE expectations test (replaces the old trailing-spend x
    // coast_multiple heuristic): deterministic rates always, even under an
    // active rates schedule (coastGrowthRate/coastTarget/coastMortgage
    // BalanceAtR are all precomputed from constant rates above). Only
    // while still working — once y reaches retirement_year the household
    // is either already retired or the notion of "coasting to R" is moot.
    if (coastYear === null && y < a.retirement_year) {
      let projected = 0.0;
      for (const acc of plan.accounts) {
        if (!acc.liquid) continue;
        projected += bal[acc.name]! * (1 + coastGrowthRate[acc.name]!) ** (a.retirement_year - y);
      }
      if (projected - coastMortgageBalanceAtR >= coastTarget) {
        coastYear = y;
      }
    }
  }

  return { rows, coast_year: coastYear, detail: details };
}
