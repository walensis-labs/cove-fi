/**
 * Golden fixture capture — run ONCE against the unmodified 0.3.0 engine to
 * pin backward-compatible behavior before any 0.4.0 src/ changes land.
 *
 * Imports straight from ../../src (via tsx) rather than dist, so it runs
 * against exactly what HEAD's source tree produces — equivalent to the
 * dist build at this commit since neither has been touched yet.
 *
 * Usage (from packages/cove-fi, BEFORE any src/ edit for 0.4.0):
 *   pnpm exec tsx test/golden/capture.mjs
 *
 * Writes:
 *   test/golden/golden-plan.json  — syntheticPlan() with COAST rungs
 *                                    stripped (contributions where both
 *                                    start and end are real years, i.e.
 *                                    not the COAST (-1) sentinel)
 *   test/golden/golden-rows.json  — run(golden-plan) rows from the
 *                                    UNMODIFIED 0.3.0 engine
 *
 * Do not re-run this script after src/ changes land — it would silently
 * re-pin the fixture to whatever behavior exists at run time, defeating
 * its purpose as a backward-compatibility regression pin.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run } from "../../src/engine.ts";
import { syntheticPlan } from "../helpers/synthetic.ts";

const here = dirname(fileURLToPath(import.meta.url));

const full = syntheticPlan();
const strippedPlan = {
  ...full,
  contributions: full.contributions.filter((c) => c.start !== -1 && c.end !== -1),
};

const rows = run(strippedPlan);

writeFileSync(join(here, "golden-plan.json"), `${JSON.stringify(strippedPlan, null, 2)}\n`);
writeFileSync(join(here, "golden-rows.json"), `${JSON.stringify(rows, null, 2)}\n`);

console.log(`wrote golden-plan.json (${strippedPlan.contributions.length} contribution rungs) and golden-rows.json (${rows.length} rows)`);
