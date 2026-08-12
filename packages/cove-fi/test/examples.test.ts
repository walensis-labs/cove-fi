/**
 * End-to-end test for the three documented starter plans in `examples/`.
 *
 * Each file must parse via `loadPlan`, run 40+ rows with finite dollar
 * metrics throughout (catches authoring mistakes — a NaN anywhere means a
 * broken account reference, bad drawdown, or similar), and tell a coherent
 * FI story: conventional-65 and coastfire both reach FI; early-52 reaches
 * FI strictly before its own retirement year (that's the point of an
 * aggressive savings rate).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Session } from "../src/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(__dirname, "..", "..", "..", "examples");

const DOLLAR_METRICS = [
  "net_worth",
  "liquid_net_worth",
  "income",
  "expenses",
  "taxes",
  "withdrawals",
  "contributions",
] as const;

// Substrings that would indicate a stray personal figure copy-pasted from
// `private/` rather than a round, invented number. Extremely unlikely to
// appear by coincidence in hand-authored round numbers.
const SUSPICIOUS_PATTERNS = [/\.\d{4,}/, /\d{3}\.\d{2}\b/];

function examplePaths(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".toml"))
    .map((f) => join(EXAMPLES_DIR, f));
}

describe("examples/ — every starter plan parses and runs end-to-end", () => {
  it("directory contains exactly the three documented starter plans", () => {
    const names = readdirSync(EXAMPLES_DIR)
      .filter((f) => f.endsWith(".toml"))
      .sort();
    expect(names).toEqual(["coastfire.toml", "conventional-65.toml", "early-52.toml"]);
  });

  for (const path of examplePaths()) {
    describe(path.split("/").at(-1), () => {
      it("loadPlan parses, run produces 40+ rows of finite dollar metrics, and has no suspicious numeric strings", () => {
        const session = new Session();
        const plan = session.loadPlanFile(path);
        expect(plan.accounts.length).toBeGreaterThan(0);

        const { rows } = session.runProjection();
        expect(rows.length).toBeGreaterThanOrEqual(40);
        for (const row of rows) {
          for (const k of DOLLAR_METRICS) {
            expect(Number.isFinite(row[k]), `${k} in year ${row.year} is not finite`).toBe(true);
          }
        }

        const raw = readFileSync(path, "utf8");
        for (const pattern of SUSPICIOUS_PATTERNS) {
          expect(pattern.test(raw), `${path} matched suspicious pattern ${pattern}`).toBe(false);
        }
      });
    });
  }

  it("conventional-65: reaches FI (non-null fi_year) at or before its own retirement_year", () => {
    // Under 0.2.0's income-relative match/tax rules, this plan's original
    // $140k salary left almost no cash-flow headroom to fund any
    // contribution rung beyond a partial 401k match, so it never reached
    // FI (see the file's header comment for the hand-derived $15k salary
    // rebalance that restores the intended "conventional household reaches
    // FI right around retirement" story).
    const session = new Session();
    session.loadPlanFile(join(EXAMPLES_DIR, "conventional-65.toml"));
    const status = session.fiStatus();
    expect(status.fi_year).not.toBeNull();
    expect(status.fi_year!).toBeLessThanOrEqual(status.retirement_year);
  });

  it("early-52: reaches FI strictly before its own retirement_year", () => {
    const session = new Session();
    session.loadPlanFile(join(EXAMPLES_DIR, "early-52.toml"));
    const status = session.fiStatus();
    expect(status.fi_year).not.toBeNull();
    expect(status.fi_year!).toBeLessThan(status.retirement_year);
  });

  it("coastfire: reaches FI (non-null fi_year) and demonstrates the COAST sentinel via a coast_year", () => {
    const session = new Session();
    const plan = session.loadPlanFile(join(EXAMPLES_DIR, "coastfire.toml"));
    const status = session.fiStatus();
    expect(status.fi_year).not.toBeNull();
    expect(status.coast_year).not.toBeNull();
    // The plan itself must contain a COAST (-1) sentinel rung.
    const hasCoastRung = plan.contributions.some((c) => c.start === -1 || c.end === -1);
    expect(hasCoastRung).toBe(true);
  });
});
