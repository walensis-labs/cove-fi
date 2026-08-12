/**
 * seed_from_ynab — mocked-client unit tests + MCP-level tests + one
 * env-gated live smoke test. `@walensis/ynab-client` is mocked for every
 * test EXCEPT the live-smoke block at the bottom, which explicitly
 * unmocks it and re-imports the module fresh so it hits the real YNAB API
 * — see that block's comment for why it has to live in this same file but
 * still avoid the mock.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { YnabClient } from "@walensis/ynab-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/mcp/server.js";
import { Session } from "../src/session.js";
import { seedFromYnab, ynabToken } from "../src/seed/ynab.js";
import { syntheticPlan } from "./helpers/synthetic.js";

const mockRequest = vi.fn();

vi.mock("@walensis/ynab-client", () => ({
  YnabClient: vi.fn().mockImplementation(() => ({ request: mockRequest })),
}));

// ---------------------------------------------------------------------
// fixtures
//
// 2 budgets ("Household", "Rental"). "Household" gets 6 months (Feb-Jul
// 2026, with `now` frozen at 2026-08-15) of recurring transactions:
//   - 2x "Acme Corp" paychecks/month, category "Inflow: Ready to Assign",
//     +$2500 each -> $5000/mo income.
//   - Rent -$1800/mo + Groceries -$300/mo, both in category group
//     "Immediate Obligations" -> $2100/mo.
//   - Car Insurance -$120/mo, group "True Expenses".
//   - Dining Out -$40/mo, group "Fun Money".
//   - A transfer -$500/mo (transfer_account_id set, category_id null) —
//     must be excluded entirely (not spending, not income); if it leaked
//     into spending it would show up as a spurious "Uncategorized" group.
//   - Two out-of-window $9999 "rent" transactions (one in January, before
//     the 6-month window; one in the current, still-open August) — if the
//     window filter were wrong these would shift Immediate Obligations'
//     monthly average off of the clean 2100 asserted below.
//
// Hand-derived expected values (all exact — every monthly figure divides
// evenly by 6, so no floating-point slop):
//   Immediate Obligations: (1800 + 300) * 6 / 6 = 2100/mo
//   True Expenses:         120 * 6 / 6          = 120/mo
//   Fun Money:              40 * 6 / 6           = 40/mo
//   income (Acme Corp):   5000 * 6 / 6          = 5000/mo
//   total expenses/mo = 2100 + 120 + 40 = 2260
//   estimated_savings_rate = 1 - 2260/5000 = 1 - 0.452 = 0.548
//   estimated_annual_expenses = 2260 * 12 = 27120
// ---------------------------------------------------------------------

const PLANS = [
  { id: "b1", name: "Household" },
  { id: "b2", name: "Rental" },
];

const CATEGORY_GROUPS_B1 = [
  {
    name: "Immediate Obligations",
    categories: [
      { id: "cat-rent", name: "Rent" },
      { id: "cat-groceries", name: "Groceries" },
    ],
  },
  { name: "True Expenses", categories: [{ id: "cat-carins", name: "Car Insurance" }] },
  { name: "Fun Money", categories: [{ id: "cat-dining", name: "Dining Out" }] },
];

function monthlyTxns() {
  const months = ["02", "03", "04", "05", "06", "07"]; // Feb-Jul 2026 — the 6 complete months before August
  const txns: unknown[] = [];
  let n = 0;
  for (const mm of months) {
    const d = (day: string) => `2026-${mm}-${day}`;
    txns.push(
      { id: `t${n++}`, date: d("01"), amount: 2500000, payee_name: "Acme Corp", category_name: "Inflow: Ready to Assign" },
      { id: `t${n++}`, date: d("15"), amount: 2500000, payee_name: "Acme Corp", category_name: "Inflow: Ready to Assign" },
      { id: `t${n++}`, date: d("03"), amount: -1800000, category_id: "cat-rent" },
      { id: `t${n++}`, date: d("10"), amount: -300000, category_id: "cat-groceries" },
      { id: `t${n++}`, date: d("05"), amount: -120000, category_id: "cat-carins" },
      { id: `t${n++}`, date: d("20"), amount: -40000, category_id: "cat-dining" },
      { id: `t${n++}`, date: d("25"), amount: -500000, transfer_account_id: "acct-savings" },
    );
  }
  // out-of-window: one before the window (January), one inside the
  // still-open current month (August) — both must be excluded.
  txns.push(
    { id: "oow-jan", date: "2026-01-15", amount: -9999000, category_id: "cat-rent" },
    { id: "oow-aug", date: "2026-08-05", amount: -9999000, category_id: "cat-rent" },
  );
  return txns;
}

function requestImpl(path: string) {
  if (path === "/plans") return Promise.resolve({ plans: PLANS });
  if (path === "/plans/b1/transactions") return Promise.resolve({ transactions: monthlyTxns() });
  if (path === "/plans/b1/categories") return Promise.resolve({ category_groups: CATEGORY_GROUPS_B1 });
  if (path === "/plans/b2/transactions") return Promise.resolve({ transactions: [] });
  if (path === "/plans/b2/categories") return Promise.resolve({ category_groups: [] });
  return Promise.reject(new Error(`unexpected request path: ${path}`));
}

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockImplementation(requestImpl);
  (YnabClient as unknown as { mockClear: () => void }).mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("ynabToken", () => {
  it("prefers COVE_FI_YNAB_TOKEN over YNAB_TOKEN", () => {
    vi.stubEnv("YNAB_TOKEN", "bare-token");
    vi.stubEnv("COVE_FI_YNAB_TOKEN", "cove-token");
    expect(ynabToken()).toBe("cove-token");
  });

  it("falls back to YNAB_TOKEN when COVE_FI_YNAB_TOKEN is absent", () => {
    vi.stubEnv("COVE_FI_YNAB_TOKEN", "");
    vi.stubEnv("YNAB_TOKEN", "bare-token");
    expect(ynabToken()).toBe("bare-token");
  });

  it("is undefined when neither is set", () => {
    vi.stubEnv("COVE_FI_YNAB_TOKEN", "");
    vi.stubEnv("YNAB_TOKEN", "");
    expect(ynabToken()).toBeUndefined();
  });
});

describe("seedFromYnab (mocked client)", () => {
  it("no token -> configured:false with instructions, and does not throw or call the network", async () => {
    vi.stubEnv("COVE_FI_YNAB_TOKEN", "");
    vi.stubEnv("YNAB_TOKEN", "");
    const proposal = await seedFromYnab();
    expect(proposal.configured).toBe(false);
    expect(proposal.instructions).toMatch(/COVE_FI_YNAB_TOKEN/);
    expect(proposal.instructions).toMatch(/YNAB_TOKEN/);
    expect(proposal.instructions).toMatch(/ynab\.com/i);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("with token: builds the proposal shape, groups spending, excludes transfers and out-of-window transactions", async () => {
    vi.stubEnv("YNAB_TOKEN", "test-token");
    const proposal = await seedFromYnab();

    expect(proposal.configured).toBe(true);
    expect(YnabClient).toHaveBeenCalledWith({ token: "test-token" });
    expect(proposal.budget_name).toBe("Household");
    expect(proposal.months_analyzed).toBe(6);

    // top-groups ordering, exact monthly figures (see fixture comment for
    // the hand-derivation) — the 2100 for Immediate Obligations proves
    // both out-of-window $9999 "rent" transactions were excluded.
    expect(proposal.monthly_spending_by_group).toEqual([
      { group: "Immediate Obligations", monthly: 2100 },
      { group: "True Expenses", monthly: 120 },
      { group: "Fun Money", monthly: 40 },
    ]);
    // no "Uncategorized" group -> the $500/mo transfer was excluded
    // entirely rather than falling through to spending.
    expect(proposal.monthly_spending_by_group!.some((g) => g.group === "Uncategorized")).toBe(false);

    expect(proposal.detected_income).toEqual([{ name: "Acme Corp", monthly_amount: 5000 }]);
    expect(proposal.estimated_annual_expenses).toBe(27120);
    expect(proposal.estimated_savings_rate).toBeCloseTo(0.548, 6);

    expect(proposal.notes!.some((n) => /multiple.*budget/i.test(n))).toBe(true);
    expect(proposal.notes!.some((n) => /Inflow: Ready to Assign/.test(n))).toBe(true);
  });

  it("budget_id selects a specific budget without the multiple-budgets note; empty budget -> savings rate 0 with anomaly note", async () => {
    vi.stubEnv("YNAB_TOKEN", "test-token");
    const proposal = await seedFromYnab({ budgetId: "b2" });

    expect(proposal.configured).toBe(true);
    expect(proposal.budget_name).toBe("Rental");
    expect(proposal.monthly_spending_by_group).toEqual([]);
    expect(proposal.detected_income).toEqual([]);
    expect(proposal.estimated_savings_rate).toBe(0);
    expect(proposal.notes!.some((n) => /multiple.*budget/i.test(n))).toBe(false);
    expect(proposal.notes!.some((n) => /no income detected/i.test(n))).toBe(true);
  });

  it("unknown budget_id -> throws (surfaces as a structured MCP error, not a crash)", async () => {
    vi.stubEnv("YNAB_TOKEN", "test-token");
    await expect(seedFromYnab({ budgetId: "does-not-exist" })).rejects.toThrow(/does-not-exist/);
  });
});

describe("mcp seed_from_ynab tool", () => {
  let client: Client;
  let session: Session;
  beforeEach(async () => {
    session = new Session();
    const server = createServer(session);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
  });

  it("is listed among the server's tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("seed_from_ynab");
  });

  it("unconfigured call (no token) returns a parseable, non-error payload", async () => {
    vi.stubEnv("COVE_FI_YNAB_TOKEN", "");
    vi.stubEnv("YNAB_TOKEN", "");
    const r = await client.callTool({ name: "seed_from_ynab", arguments: {} });
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse((r.content as { text: string }[])[0]!.text);
    expect(payload.configured).toBe(false);
    expect(typeof payload.instructions).toBe("string");
  });

  it("configured call through MCP returns the same proposal shape as calling seedFromYnab directly", async () => {
    vi.stubEnv("YNAB_TOKEN", "test-token");
    const r = await client.callTool({ name: "seed_from_ynab", arguments: { budget_id: "b2" } });
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse((r.content as { text: string }[])[0]!.text);
    expect(payload.configured).toBe(true);
    expect(payload.budget_name).toBe("Rental");
  });

  it("PROPOSE-ONLY: never touches session.plan, whether unloaded or already loaded", async () => {
    vi.stubEnv("YNAB_TOKEN", "test-token");

    // unloaded case
    expect(session.plan).toBeNull();
    await client.callTool({ name: "seed_from_ynab", arguments: {} });
    expect(session.plan).toBeNull();

    // already-loaded case — snapshot before/after must be identical, not
    // just "still an object" (a shallow-merge bug in a future refactor
    // would still leave `plan` truthy but change its contents).
    const before = session.createPlan(syntheticPlan());
    const snapshot = JSON.parse(JSON.stringify(session.plan));
    await client.callTool({ name: "seed_from_ynab", arguments: {} });
    expect(session.plan).toEqual(snapshot);
    expect(before).toBeTruthy();
  });
});

// The env-gated live smoke test lives in test/seed-ynab.live.test.ts, NOT
// here: vitest's `vi.mock`/`vi.unmock` hoisting is file-scoped and static
// (it hoists every `vi.mock`/`vi.unmock` call in a file to the top
// regardless of nesting) — a `vi.unmock` anywhere in this file, even
// inside a conditionally-skipped test, would cancel the `vi.mock` above
// for every test in the file. A separate, unmocked file is the only
// reliable way to let one real-network smoke test coexist with the
// mocked unit tests above.
