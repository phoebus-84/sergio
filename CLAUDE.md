@AGENTS.md

## In Claude Code

- The studio's tools are `mcp__pva__pva_*`; the slash commands are the
  server's prompts (`/mcp__pva__video`, `/mcp__pva__render`, …).
- `.claude/settings.json` allows the read-only tools and adds two hooks: a
  `SessionStart` check that the studio serves this library, and a
  `UserPromptSubmit` hook that hands you studio activity with each prompt.
  `npm run studio:claude` delivers review activity as it arrives instead.
