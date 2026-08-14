/**
 * Validation shell for the 0.5.0 additive schema fields, PLUS the engine
 * behavior Task 3 wires up on top of them:
 *   - Contribution.name (optional, non-empty, unique among named rungs)
 *   - Contribution.hard_end (optional, plain finite integer year — COAST/
 *     RETIREMENT sentinels rejected)
 *   - Account.earmarked (optional, default false; earmarked + explicit
 *     liquid:true is rejected)
 *
 * The engine reads `earmarked` for two things (0.5.0 Task 3): NW reporting
 * (earmarked balances sum into YearRow.earmarked_net_worth and are excluded
 * from net_worth) and retirement drawdown exclusion (the discretionary
 * drawdown waterfall skips earmarked accounts entirely — see engine.ts's
 * `if (acc.earmarked) continue;` guard, right after the `acc.tax !== tt`
 * check). The earlier schema-only validation tests below still just
 * exercise normalizePlan()'s defaulting and planFromJson()'s validation;
 * the engine-behavior describe blocks further down exercise the guard.
 */
import { describe, expect, it } from "vitest";
import { run, runWithMeta } from "../src/engine.js";
import { COAST, DEFAULT_ASSUMPTIONS, normalizePlan, RETIREMENT, type Plan } from "../src/model.js";
import { planFromJson } from "../src/planjson.js";
import { runMonteCarlo } from "../src/montecarlo.js";
import { Session } from "../src/session.js";
import { syntheticPlan } from "./helpers/synthetic.js";

// syntheticPlan() is already normalized (built via normalizePlan), and
// already valid per planFromJson — deep-clone it so each test can mutate
// its own copy without cross-test bleed.
const basePlan = (): Plan => JSON.parse(JSON.stringify(syntheticPlan()));

describe("Account.earmarked — normalizePlan defaults", () => {
  it("defaults to false when absent", () => {
    const p = normalizePlan(basePlan());
    expect(p.accounts.every((a) => a.earmarked === false)).toBe(true);
  });

  it("earmarked:true forces liquid:false even when liquid is absent", () => {
    const raw = basePlan();
    delete (raw.accounts[0] as { liquid?: boolean }).liquid;
    raw.accounts[0]!.earmarked = true;
    const p = normalizePlan(raw);
    expect(p.accounts[0]!.earmarked).toBe(true);
    expect(p.accounts[0]!.liquid).toBe(false);
  });

  it("earmarked:false leaves liquid defaulting to true as before", () => {
    const raw = basePlan();
    delete (raw.accounts[0] as { liquid?: boolean }).liquid;
    raw.accounts[0]!.earmarked = false;
    const p = normalizePlan(raw);
    expect(p.accounts[0]!.liquid).toBe(true);
  });
});

describe("Account.earmarked — planFromJson validation", () => {
  it("rejects a non-boolean earmarked", () => {
    const p = basePlan();
    (p.accounts[0] as unknown as Record<string, unknown>).earmarked = "yes";
    expect(() => planFromJson(p)).toThrowError(/earmarked must be a boolean/);
  });

  it("rejects earmarked:true with EXPLICIT liquid:true, naming the account", () => {
    const p = basePlan();
    p.accounts[0]!.earmarked = true;
    p.accounts[0]!.liquid = true;
    expect(() => planFromJson(p)).toThrowError(
      new RegExp(`${p.accounts[0]!.name}: earmarked accounts cannot be liquid`),
    );
  });

  it("accepts earmarked:true with ABSENT liquid (implied non-liquid, not an error)", () => {
    const p = basePlan();
    delete (p.accounts[0] as { liquid?: boolean }).liquid;
    p.accounts[0]!.earmarked = true;
    expect(() => planFromJson(p)).not.toThrow();
  });

  it("accepts earmarked:true with EXPLICIT liquid:false", () => {
    const p = basePlan();
    p.accounts[0]!.earmarked = true;
    p.accounts[0]!.liquid = false;
    expect(() => planFromJson(p)).not.toThrow();
  });

  it("accepts earmarked:false with liquid:true", () => {
    const p = basePlan();
    p.accounts[0]!.earmarked = false;
    p.accounts[0]!.liquid = true;
    expect(() => planFromJson(p)).not.toThrow();
  });
});

describe("Contribution.name", () => {
  it("accepts a non-empty name", () => {
    const p = basePlan();
    p.contributions[0]!.name = "match-401k";
    expect(() => planFromJson(p)).not.toThrow();
    expect(planFromJson(p).contributions[0]!.name).toBe("match-401k");
  });

  it("rejects an empty-string name", () => {
    const p = basePlan();
    (p.contributions[0] as unknown as Record<string, unknown>).name = "";
    expect(() => planFromJson(p)).toThrowError(/name must be a non-empty string/);
  });

  it("rejects a non-string name", () => {
    const p = basePlan();
    (p.contributions[0] as unknown as Record<string, unknown>).name = 42;
    expect(() => planFromJson(p)).toThrowError(/name must be a non-empty string/);
  });

  it("leaving name absent on multiple rungs is fine (no false-positive collision)", () => {
    const p = basePlan();
    expect(p.contributions.length).toBeGreaterThan(1);
    expect(() => planFromJson(p)).not.toThrow();
  });

  it("rejects a duplicate name among named rungs, naming the duplicate exactly once", () => {
    const p = basePlan();
    expect(p.contributions.length).toBeGreaterThanOrEqual(3);
    p.contributions[0]!.name = "dup";
    p.contributions[1]!.name = "dup";
    p.contributions[2]!.name = "unique";
    let issues: string[] = [];
    try {
      planFromJson(p);
      throw new Error("expected planFromJson to throw");
    } catch (err) {
      issues = (err as { issues: string[] }).issues;
    }
    const dupIssues = issues.filter((s) => s.includes("dup"));
    expect(dupIssues.length).toBe(1);
  });

  it("allows the same name to be reused as an account name (different namespace)", () => {
    const p = basePlan();
    p.contributions[0]!.name = p.accounts[0]!.name;
    expect(() => planFromJson(p)).not.toThrow();
  });
});

describe("Contribution.hard_end", () => {
  it("accepts a plain finite integer year", () => {
    const p = basePlan();
    p.contributions[0]!.hard_end = 2060;
    expect(() => planFromJson(p)).not.toThrow();
    expect(planFromJson(p).contributions[0]!.hard_end).toBe(2060);
  });

  it("rejects the COAST (-1) sentinel with a named issue", () => {
    const p = basePlan();
    p.contributions[0]!.hard_end = COAST;
    expect(() => planFromJson(p)).toThrowError(/hard_end must be a plain year/);
  });

  it("rejects the RETIREMENT (-2) sentinel with a named issue", () => {
    const p = basePlan();
    p.contributions[0]!.hard_end = RETIREMENT;
    expect(() => planFromJson(p)).toThrowError(/hard_end must be a plain year/);
  });

  it("rejects a non-integer hard_end", () => {
    const p = basePlan();
    (p.contributions[0] as unknown as Record<string, unknown>).hard_end = 2050.5;
    expect(() => planFromJson(p)).toThrowError(/hard_end/);
  });

  it("rejects a non-numeric hard_end", () => {
    const p = basePlan();
    (p.contributions[0] as unknown as Record<string, unknown>).hard_end = "2050";
    expect(() => planFromJson(p)).toThrowError(/hard_end/);
  });
});

/**
 * 0.5.0 Task 3: the engine now reads Account.earmarked. Earmarked balances
 * sum into YearRow.earmarked_net_worth and are EXCLUDED from net_worth;
 * legacy `liquid:false` non-earmarked accounts (e.g. a 529) are unaffected
 * — they stay inside net_worth exactly as before (il529 path unchanged).
 * liquid_net_worth is untouched either way (earmarked already implies
 * non-liquid, so it was never counted there).
 */
describe("engine — earmarked NW reporting split", () => {
  function buildPlan(): Plan {
    return normalizePlan({
      birth_year: 1990,
      accounts: [
        { name: "liquid", tax: "taxable", balance: 50_000, basis: 50_000, growth: 0 },
        // earmarked:true forces liquid:false (normalizePlan) — explicit
        // liquid left absent to exercise that default path too.
        { name: "house_fund", tax: "cash", balance: 20_000, growth: 0, earmarked: true },
        // legacy liquid:false, non-earmarked — the pre-0.5.0 il529 path.
        { name: "college529", tax: "529", balance: 10_000, growth: 0, liquid: false },
      ],
      incomes: [],
      social_security: [],
      expenses: [],
      contributions: [],
      house: null,
      assumptions: { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2026, retirement_year: 2050 },
    });
  }

  it("earmarked balance sums into earmarked_net_worth and is excluded from net_worth; legacy liquid:false stays in net_worth; liquid_net_worth untouched", () => {
    const [row] = run(buildPlan());
    expect(row!.earmarked_net_worth).toBe(20_000);
    // net_worth = liquid (50,000) + legacy il529 (10,000) + house value (0) -
    // mortgage (0) — house_fund's 20,000 is excluded entirely.
    expect(row!.net_worth).toBe(60_000);
    expect(row!.liquid_net_worth).toBe(50_000);
  });
});

describe("engine — earmarked exclusion pins (coast/fi/depletion/MC keyed off liquid, unaffected by earmarked balance)", () => {
  // "B" (hsa — withdrawals carry no capital-gains gross-up, so there is no
  // residual leak into the drawdown order's "cash" tier) is the plan's only
  // LIQUID account and drives coast/fi/depletion/MC entirely on its own;
  // "house_fund" (earmarked, tax "cash" — last in the drawdown order) is
  // sized so it's never touched by the retirement waterfall (B alone
  // comfortably covers every year's need across the whole horizon) — a
  // precondition for the "scales by exactly 100x" assertion below to hold
  // (if the waterfall ever drew from it, the residual would be a FIXED
  // dollar amount independent of its starting balance, breaking exact
  // proportionality).
  function buildPlan(earmarkedBalance: number): Plan {
    return normalizePlan({
      birth_year: 1990,
      accounts: [
        { name: "B", tax: "hsa", balance: 10_000 },
        { name: "house_fund", tax: "cash", balance: earmarkedBalance, growth: 0, earmarked: true },
      ],
      incomes: [{ name: "salary", amount: 500_000, start: 2026, end: 2030 }],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [{ account: "B", start: 2026, end: COAST, amount: 200_000 }],
      house: null,
      assumptions: {
        ...DEFAULT_ASSUMPTIONS,
        start_year: 2026,
        end_year: 2060,
        retirement_year: 2031,
        inflation: 0,
        fi_multiple: 25,
        ret: 0.07,
      },
    });
  }

  it("inflating the earmarked balance 100x moves fi_year/coast_year/depletion_year/MC success_rate/net_worth NOT AT ALL, and earmarked_net_worth EXACTLY 100x", () => {
    const plan1 = buildPlan(5_000);
    const plan2 = buildPlan(500_000);

    const session1 = new Session();
    session1.plan = plan1;
    const session2 = new Session();
    session2.plan = plan2;
    const fi1 = session1.fiStatus();
    const fi2 = session2.fiStatus();

    // sanity: this probe actually exercises non-trivial fi/coast (not a
    // vacuous null === null check).
    expect(fi1.coast_year).not.toBeNull();
    expect(fi1.fi_year).not.toBeNull();

    expect(fi2.coast_year).toBe(fi1.coast_year);
    expect(fi2.fi_year).toBe(fi1.fi_year);
    expect(fi2.depletion_year).toBe(fi1.depletion_year);
    expect(fi2.terminal_net_worth).toBe(fi1.terminal_net_worth);

    expect(fi1.terminal_earmarked_net_worth).toBe(5_000);
    expect(fi2.terminal_earmarked_net_worth).toBeCloseTo(fi1.terminal_earmarked_net_worth * 100, 6);

    const mc1 = runMonteCarlo(plan1, { trials: 30, seed: 42 });
    const mc2 = runMonteCarlo(plan2, { trials: 30, seed: 42 });
    expect(mc2.success_rate).toBe(mc1.success_rate);
  });
});

/**
 * CRITICAL fix-round pin: the retirement drawdown waterfall (engine.ts's
 * `order = ["taxable", "hsa", "trad", "roth", "cash"]` loop) is keyed
 * purely on `acc.tax`, not on `liquid`/`earmarked` — so, unlike the
 * hsa-typed probe above (which the waterfall never even reaches, because
 * "B" alone always covers the need), an earmarked account of a class the
 * waterfall DOES reach must be actively excluded, or it gets raided once
 * the plan's other liquid accounts run dry. `engine.ts` now has
 * `if (acc.earmarked) continue;` right after the `acc.tax !== tt` check
 * for exactly this reason.
 *
 * "house_fund" here is `tax: "taxable"` — the FIRST tier in the drawdown
 * order, and the same tier as "B" (the plan's only liquid account) — so
 * without the guard it would be drawn from immediately once B is
 * exhausted, in the very same pass. Manually verified (locally, not
 * committed): temporarily short-circuiting the guard
 * (`if (acc.earmarked && false) continue;`) makes house_fund's balance
 * decline starting the very first retirement year in both scenarios below
 * (5,000 -> 0 by the depletion year; 500,000 draining by thousands/year
 * once B is gone) — i.e. this test's "byte-identical through retirement"
 * assertion is a real regression guard against that guard being removed,
 * not a vacuous one.
 *
 * retirement_year === start_year (immediate retirement) so every simulated
 * year exercises the retirement drawdown loop, no working-year cash-flow
 * quirks involved. B (liquid, taxable, $150k) is sized to genuinely
 * exhaust a few years in against a flat $40k/yr expense — giving a
 * NON-null depletion_year on both sides (closing the earlier null===null
 * weakness in the probe above). Note: because house_fund is ALSO `tax:
 * "taxable"`, it still accrues the household's ordinary dividend tax
 * (engine.ts's `div` loop sums ALL taxable-class balances, earmarked or
 * not — real accounts pay real tax on real dividends regardless of what
 * they're earmarked for) — so, unlike the hsa probe above, net_worth is
 * NOT asserted equal between the two runs here; that small tax-driven
 * divergence is expected and orthogonal to what this pin is checking.
 */
describe("engine — earmarked retirement-drawdown exclusion (CRITICAL: earmarked accounts must never be raided by the discretionary waterfall)", () => {
  function buildPlan(earmarkedBalance: number): Plan {
    return normalizePlan({
      birth_year: 1990,
      accounts: [
        { name: "B", tax: "taxable", balance: 150_000, basis: 150_000, growth: 0.03 },
        { name: "house_fund", tax: "taxable", balance: earmarkedBalance, growth: 0, earmarked: true },
      ],
      incomes: [],
      social_security: [],
      expenses: [{ name: "living", amount: 40_000, start: 2026, end: 2091 }],
      contributions: [],
      house: null,
      assumptions: {
        ...DEFAULT_ASSUMPTIONS,
        start_year: 2026,
        end_year: 2040,
        retirement_year: 2026,
        inflation: 0,
        fi_multiple: 25,
      },
    });
  }

  it("B (liquid, taxable) genuinely exhausts (non-null depletion_year, identical both sides) while house_fund (earmarked, taxable — the SAME drawdown tier) stays byte-identical through every retirement year, and scales exactly 100x", () => {
    const plan1 = buildPlan(5_000);
    const plan2 = buildPlan(500_000);
    const r1 = runWithMeta(plan1);
    const r2 = runWithMeta(plan2);

    const depletionYear = (rows: typeof r1.rows, retirementYear: number) =>
      rows.find((r) => r.year >= retirementYear && r.liquid_net_worth <= 0)?.year ?? null;
    const dep1 = depletionYear(r1.rows, 2026);
    const dep2 = depletionYear(r2.rows, 2026);

    // sanity: non-vacuous — B genuinely runs dry within the horizon.
    expect(dep1).not.toBeNull();
    expect(dep2).toBe(dep1);

    // house_fund is NEVER touched: flat at its starting balance in EVERY
    // row, including every year after B (and thus liquid_net_worth) hits
    // zero — the exact scenario where, without the guard, the waterfall
    // would otherwise cascade into it.
    for (const r of r1.rows) expect(r.earmarked_net_worth).toBe(5_000);
    for (const r of r2.rows) expect(r.earmarked_net_worth).toBe(500_000);

    // exact 100x relationship end to end (not just at the terminal row).
    for (let i = 0; i < r1.rows.length; i++) {
      expect(r2.rows[i]!.earmarked_net_worth).toBeCloseTo(r1.rows[i]!.earmarked_net_worth * 100, 6);
    }
  });
});

describe("fund_from drawdown from an earmarked account — existing engine mechanic re-pinned under the earmarked NW split", () => {
  // Identical plans except accounts[0].earmarked — the fund_from loop reads
  // bal[name] directly and has never consulted `liquid`/`earmarked`, so the
  // withdrawal timeline/amounts (and every other cash-flow field) must come
  // out byte-identical. The ONLY difference the earmarked flag should make
  // is where that account's balance is reported: inside net_worth (legacy,
  // earmarked:false) vs inside earmarked_net_worth (earmarked:true).
  function buildPlan(earmarked: boolean): Plan {
    return normalizePlan({
      birth_year: 1990,
      accounts: [{ name: "college529", tax: "529", balance: 12_000, liquid: false, earmarked }],
      incomes: [{ name: "salary", amount: 100_000, start: 2026, end: 2051 }],
      social_security: [],
      expenses: [
        { name: "base", amount: 40_000, start: 2026, end: 2091 },
        { name: "college", amount: 15_000, start: 2040, end: 2043, fund_from: "college529" },
      ],
      contributions: [],
      house: null,
      assumptions: { ...DEFAULT_ASSUMPTIONS, start_year: 2026, end_year: 2045, retirement_year: 2052 },
    });
  }

  it("withdrawals/expenses/income/taxes are byte-identical whether or not the source account is earmarked; only the NW split moves", () => {
    const legacy = run(buildPlan(false));
    const earmarkedRun = run(buildPlan(true));
    expect(earmarkedRun.length).toBe(legacy.length);
    let sawWithdrawal = false;
    for (let i = 0; i < legacy.length; i++) {
      const l = legacy[i]!;
      const e = earmarkedRun[i]!;
      expect(e.withdrawals).toBe(l.withdrawals);
      expect(e.expenses).toBe(l.expenses);
      expect(e.income).toBe(l.income);
      expect(e.taxes).toBe(l.taxes);
      if (l.withdrawals > 0) sawWithdrawal = true;
      // legacy: the 529's balance stays inside net_worth, never reported as
      // earmarked. earmarked: it moves out of net_worth entirely.
      expect(l.earmarked_net_worth).toBe(0);
      expect(e.net_worth + e.earmarked_net_worth).toBeCloseTo(l.net_worth, 6);
    }
    expect(sawWithdrawal).toBe(true); // sanity: fund_from actually fired
  });
});
