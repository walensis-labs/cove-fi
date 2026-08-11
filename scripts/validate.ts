/**
 * Diff cove-fi engine output against a ProjectionLab Reports export.
 *
 * TS port of validate.py (cove-fi-python-reference). Reproduces its logic
 * exactly: snapshot-row skip, sample-year list, three Δ% column groups
 * (NW, LNW, Expenses), mean/max |Δ| summary over NW and LNW, and the 2027
 * five-metric detail block.
 *
 * Paths come from env (not argv) so the harness never needs personal
 * finance data baked into a command line or a repo file:
 *   COVE_FI_PRIVATE_PLAN   - path to plan_aj.json (or equivalent plan JSON)
 *   COVE_FI_PRIVATE_REPORT - path to a ProjectionLab Reports export JSON
 */
import { readFileSync } from "node:fs";
import { planFromJson, run, type YearRow } from "@walensis/cove-fi";

const PLAN_PATH = process.env.COVE_FI_PRIVATE_PLAN;
const REPORT_PATH = process.env.COVE_FI_PRIVATE_REPORT;

if (!PLAN_PATH || !REPORT_PATH) {
  console.error(
    "usage: COVE_FI_PRIVATE_PLAN=<plan.json> COVE_FI_PRIVATE_REPORT=<pl-report.json> pnpm validate",
  );
  process.exit(2);
}

type PlRow = Record<string, unknown>;

/** "" -> null (PL leaves numeric cells blank on the snapshot row); else Number(v). */
function num(v: unknown): number | null {
  if (v === "") return null;
  return typeof v === "number" ? v : Number(v);
}

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Right-pad-free right-align to `width` (Python's f"{x:>N}"). */
function padStart(s: string, width: number): string {
  return s.padStart(width, " ");
}

/** Python's f"{v:>N,.0f}" - comma-grouped integer, right-aligned to width. */
function fmtInt(v: number, width: number): string {
  return padStart(intFmt.format(Math.round(v)), width);
}

/** Python's f"{v:>6.1f}%" - one decimal, right-aligned to 6, literal '%' appended. */
function fmtPct(v: number): string {
  const s = Number.isNaN(v) ? "nan" : v.toFixed(1);
  return padStart(s, 6) + "%";
}

function main() {
  const raw = JSON.parse(readFileSync(PLAN_PATH as string, "utf-8"));
  const plan = planFromJson(raw);

  const rawReport: PlRow[] = JSON.parse(readFileSync(REPORT_PATH as string, "utf-8"));

  // row 0 is the current-finances snapshot (duplicate 2026); drop it
  const pl = new Map<number, PlRow>();
  let seen2026 = false;
  for (const r of rawReport) {
    const y = r.Year as number;
    if (y === 2026 && !seen2026 && r.Income === "") {
      seen2026 = true;
      continue;
    }
    pl.set(y, r);
  }

  const ours = new Map<number, YearRow>();
  for (const row of run(plan)) {
    ours.set(row.year, row);
  }

  console.log(
    `${padStart("Year", 4)} ${padStart("PL NetWorth", 14)} ${padStart("Ours", 14)} ${padStart("Δ%", 7)} | ` +
      `${padStart("PL LNW", 13)} ${padStart("Ours", 13)} ${padStart("Δ%", 7)} | ${padStart("PL Exp", 10)} ${padStart("Ours", 10)} ${padStart("Δ%", 7)}`,
  );

  const errsNw: number[] = [];
  const errsLnw: number[] = [];
  const sampleYears = new Set([
    2026, 2027, 2028, 2030, 2035, 2040, 2045, 2050, 2051, 2052, 2055, 2060, 2065, 2070, 2080, 2091,
  ]);

  const years = [...pl.keys()].sort((a, b) => a - b);
  for (const y of years) {
    const p = pl.get(y) as PlRow;
    const o = ours.get(y);
    if (o === undefined) continue;

    const pnw = num(p["Net Worth"]);
    const plnw = num(p["Liquid Net Worth"]);
    const dnw = pnw ? (100 * (o.net_worth - pnw)) / pnw : 0;
    const dlnw = plnw ? (100 * (o.liquid_net_worth - plnw)) / plnw : 0;
    errsNw.push(Math.abs(dnw));
    errsLnw.push(Math.abs(dlnw));

    if (sampleYears.has(y)) {
      const pexp = num(p["Expenses"]);
      const dexp = pexp ? (100 * (o.expenses - pexp)) / pexp : NaN;
      const pexpS = pexp !== null ? fmtInt(pexp, 10) : padStart("—", 10);
      console.log(
        `${padStart(String(y), 4)} ${fmtInt(pnw ?? 0, 14)} ${fmtInt(o.net_worth, 14)} ${fmtPct(dnw)} | ` +
          `${fmtInt(plnw ?? 0, 13)} ${fmtInt(o.liquid_net_worth, 13)} ${fmtPct(dlnw)} | ${pexpS} ${fmtInt(o.expenses, 10)} ${fmtPct(dexp)}`,
      );
    }
  }

  console.log(
    `\nNet worth   — mean |Δ|: ${(errsNw.reduce((a, b) => a + b, 0) / errsNw.length).toFixed(1)}%   ` +
      `max |Δ|: ${Math.max(...errsNw).toFixed(1)}%`,
  );
  console.log(
    `Liquid NW   — mean |Δ|: ${(errsLnw.reduce((a, b) => a + b, 0) / errsLnw.length).toFixed(1)}%   ` +
      `max |Δ|: ${Math.max(...errsLnw).toFixed(1)}%`,
  );

  // first-year sanity: compare every metric for 2027 (first full year)
  const p27 = pl.get(2027);
  const o27 = ours.get(2027);
  if (p27 && o27) {
    console.log("\n2027 (first full year) detail:");
    const metrics: [string, number | null, number][] = [
      ["Income", num(p27["Income"]), o27.income],
      ["Expenses", num(p27["Expenses"]), o27.expenses],
      ["Taxes", num(p27["Taxes"]), o27.taxes],
      ["Contributions", num(p27["Contributions"]), o27.contributions],
      ["Withdrawals", num(p27["Withdrawals"]), o27.withdrawals],
    ];
    for (const [label, pv, ov] of metrics) {
      if (pv !== null) {
        const d = pv ? (100 * (ov - pv)) / pv : 0;
        console.log(
          `  ${label.padEnd(14)} PL ${fmtInt(pv, 12)}   ours ${fmtInt(ov, 12)}   Δ ${fmtPct(d)}`,
        );
      }
    }
  }
}

main();
