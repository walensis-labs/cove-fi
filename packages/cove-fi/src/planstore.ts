/**
 * Plan storage/discovery convention (`~/.cove-fi/plans`).
 *
 * `plansDir()` re-reads `COVE_FI_PLANS` on every call (not cached at module
 * load) so tests can stub the env var per-test with `vi.stubEnv` and see it
 * take effect immediately, and so a long-running process (e.g. the MCP
 * server) picks up an env change without a restart.
 *
 * `listPlans` never creates the store directory — a missing store dir is
 * just an empty contribution to the list, not an error. It combines two
 * non-recursive sources: `*.toml` directly in `plansDir()` (source:
 * "store") and `*.toml` directly in `process.cwd()` (source: "cwd"),
 * sorted by mtime descending so the most recently touched plan sorts
 * first regardless of source.
 *
 * `savePlan` validates the slug against `PLAN_NAME_RE` *before* resolving
 * anything (so `../evil` fails on the regex, not the filesystem check),
 * then after joining verifies the resolved path still starts with
 * `plansDir() + sep` — belt and braces against traversal even though the
 * regex already forbids `/`.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { dumpPlan } from "./planfile.js";
import type { Plan } from "./model.js";

export interface PlanEntry {
  name: string;
  path: string;
  mtime: string;
  source: "store" | "cwd";
}

/** Slug for a plan name: letters/digits/hyphen/underscore, 1-64 chars, must not start with `-` or `_`. */
export const PLAN_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

export function plansDir(): string {
  return process.env.COVE_FI_PLANS || join(homedir(), ".cove-fi", "plans");
}

function tomlEntriesIn(dir: string, source: "store" | "cwd"): PlanEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".toml"))
    .map((d) => {
      const path = join(dir, d.name);
      const stat = statSync(path);
      return {
        name: d.name.slice(0, -".toml".length),
        path,
        mtime: stat.mtime.toISOString(),
        source,
      };
    });
}

export function listPlans(): PlanEntry[] {
  const entries = [...tomlEntriesIn(plansDir(), "store"), ...tomlEntriesIn(process.cwd(), "cwd")];
  return entries.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
}

export function resolvePlanRef(ref: string): string {
  if (ref.includes(sep) || ref.endsWith(".toml")) return resolve(ref);
  return join(plansDir(), `${ref}.toml`);
}

export function savePlan(name: string, plan: Plan, opts?: { overwrite?: boolean }): string {
  if (!PLAN_NAME_RE.test(name)) {
    throw new Error(`Invalid plan name "${name}": must match ${PLAN_NAME_RE}`);
  }
  const dir = plansDir();
  const path = join(dir, `${name}.toml`);
  if (!path.startsWith(dir + sep)) {
    throw new Error(`Refusing to write plan outside plans dir: ${path}`);
  }
  if (existsSync(path) && !opts?.overwrite) {
    throw new Error(`Plan "${name}" already exists at ${path} (pass overwrite: true to replace it)`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, dumpPlan(plan), "utf8");
  return path;
}
