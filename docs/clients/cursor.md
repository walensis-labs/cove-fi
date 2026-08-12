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

## Onboarding

Prompt support varies by Cursor version — if MCP prompts are surfaced in
your build, look for `cove-fi`'s `onboard` prompt there. Either way, just
typing "set up my retirement plan" in the chat works: Cursor's model can
call the same tools directly even without native prompt support.

## Example prompts

- "Load my-plan.toml and tell me if I'm on track. Then try retirement at 57
  instead — how much does that move the FI year?"
- "What if I take a 25% Social Security haircut — does my plan still work?"
- "Compare retiring at 60 vs 65 and show me the terminal net worth delta."

Note: salary ends at retirement automatically when its plan `end` is set to
`"retirement"` — a retirement-year what-if moves it right along with the
work/retirement boundary, no separate edit needed.
