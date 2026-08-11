# Claude Code

## Setup

```bash
claude mcp add cove-fi -- npx -y @walensis/cove-fi mcp
```

That registers `cove-fi` as an MCP server for Claude Code. Verify it's
connected with `claude mcp list` — `cove-fi` should show as `connected`.
Start a new session and ask Claude to load a plan file with `load_plan`
(or just describe your situation and let it call the tool).

## Example prompts

- "Load my-plan.toml and tell me if I'm on track. Then try retirement at 57
  instead — how much does that move the FI year?"
- "What if I take a 25% Social Security haircut — does my plan still work?"
- "Compare retiring at 60 vs 65 and show me the terminal net worth delta."

Note: a retirement-year what-if moves the work/retirement boundary
(contributions stop, drawdown starts) but doesn't shorten your income
events' own `end` dates — for an accurate early-retirement comparison,
also tell Claude to end (or edit) your salary income at the new year.
