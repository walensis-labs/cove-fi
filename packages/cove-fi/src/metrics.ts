/**
 * Single source of truth for the *meaning* of the engine's derived
 * metrics — separate from the code that computes them (engine.ts/session.ts)
 * so a definition can be read (and its version checked) without importing
 * the projection machinery.
 *
 * METRICS_VERSION bumps whenever a definition below changes in a way that
 * would silently change what a previously-fetched number means (e.g.
 * coast_year's contributions-inclusion rule changing mid-session). A caller
 * that cached `get_engine_info`'s metrics_version can detect the change by
 * re-checking it rather than by noticing numbers drifted.
 */
export const METRICS_VERSION = "1";

export const METRIC_DEFINITIONS: Record<string, string> = {
  fi_year: "First year liquid net worth >= fi_multiple x that year's expenses.",
  coast_year:
    "First year current liquid balances, grown at their resolved rates with no further contributions, reach fi_multiple x projected retirement-year spending (net of the mortgage balance at retirement).",
  depletion_year: "First year at or after retirement_year when liquid net worth <= 0; null if it never happens.",
  terminal_net_worth: "Final-year net worth, excluding earmarked accounts.",
  earmarked_net_worth: "Sum of earmarked account balances; excluded from net_worth.",
  terminal_earmarked_net_worth: "Final-year earmarked total.",
};
