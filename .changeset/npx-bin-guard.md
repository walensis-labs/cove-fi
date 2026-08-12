---
"@walensis/cove-fi": patch
---

Fix: the CLI and MCP server were silent no-ops when invoked through npm's bin
symlink (npx, global installs, Claude Desktop/Cursor configs). The script-
execution guard compared import.meta.url against the un-resolved argv[1]
symlink path; both sides are now realpath'd. Direct `node dist/cli.js`
invocations were unaffected, which is why tests and local smokes passed.
