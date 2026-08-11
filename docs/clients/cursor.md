# Cursor

## Setup

Add this to `.cursor/mcp.json` (project-level) or your global Cursor MCP
config, then reload Cursor:

```json
{
  "mcpServers": {
    "cove-fi": {
      "command": "npx",
      "args": ["-y", "@walensis/cove-fi", "mcp"]
    }
  }
}
```

Open the MCP settings panel and confirm `cove-fi` shows as enabled with its
tools listed (`load_plan`, `run_projection`, `fi_status`, `run_scenario`,
`compare_scenarios`, ...).

## Example prompts

- "Load my-plan.toml and tell me if I'm on track. Then try retirement at 57
  instead — how much does that move the FI year?"
- "What if I take a 25% Social Security haircut — does my plan still work?"
- "Compare retiring at 60 vs 65 and show me the terminal net worth delta."

Note: a retirement-year what-if moves the work/retirement boundary
(contributions stop, drawdown starts) but doesn't shorten your income
events' own `end` dates — for an accurate early-retirement comparison,
also tell Claude to end (or edit) your salary income at the new year.
