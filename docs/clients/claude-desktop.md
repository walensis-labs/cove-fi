# Claude Desktop

## Setup

Add this to your `claude_desktop_config.json` (Settings → Developer → Edit
Config), then restart Claude Desktop:

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

Open a new chat and confirm the hammer/tools icon lists `cove-fi`'s tools
(`load_plan`, `run_projection`, `fi_status`, `run_scenario`,
`compare_scenarios`, ...).

## Onboarding

Claude Desktop surfaces MCP prompts through the `+` / prompts picker next
to the message box — pick `cove-fi`'s `onboard` prompt there, or just type
"set up my retirement plan" in the chat to invoke it directly.

## Example prompts

- "Load my-plan.toml and tell me if I'm on track. Then try retirement at 57
  instead — how much does that move the FI year?"
- "What if I take a 25% Social Security haircut — does my plan still work?"
- "Compare retiring at 60 vs 65 and show me the terminal net worth delta."

Note: salary ends at retirement automatically when its plan `end` is set to
`"retirement"` — a retirement-year what-if moves it right along with the
work/retirement boundary, no separate edit needed.
