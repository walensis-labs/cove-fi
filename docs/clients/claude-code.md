# Claude Code

## Setup

```bash
claude mcp add cove-fi -- npx -y @walensis/cove-fi mcp
```

That registers `cove-fi` as an MCP server for Claude Code. Verify it's
connected with `claude mcp list` — `cove-fi` should show as `connected`.
Start a new session and ask Claude to load a plan file with `load_plan`
(or just describe your situation and let it call the tool).

## Onboarding

Claude Code exposes MCP prompts as slash commands
(`/mcp__cove-fi__onboard`), or just type "set up my retirement plan" in
the chat — Claude will invoke the `onboard` prompt (or drive the same
flow tool-by-tool if the prompt isn't available) either way.

## Example prompts

- "Load my-plan.toml and tell me if I'm on track. Then try retirement at 57
  instead — how much does that move the FI year?"
- "What if I take a 25% Social Security haircut — does my plan still work?"
- "Compare retiring at 60 vs 65 and show me the terminal net worth delta."

Note: salary ends at retirement automatically when its plan `end` is set to
`"retirement"` — a retirement-year what-if moves it right along with the
work/retirement boundary, no separate edit needed.
