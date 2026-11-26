// ---------------------------------------------------------------------------
// Claude Code SessionStart hook: is this session's library the studio's?
// ---------------------------------------------------------------------------
// The same check the extension makes at Pi's session_start (see
// ../mcp/library-check.ts). Says so, and only then.
//
//   cd "$CLAUDE_PROJECT_DIR" && node --import tsx studio/agent/claude/session-start.ts
// ---------------------------------------------------------------------------

import { libraryVisibilityWarning } from "../mcp/library-check.js";

async function main(): Promise<void> {
  const message = await libraryVisibilityWarning();
  if (!message) return;
  process.stdout.write(
    JSON.stringify({
      systemMessage: message,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message },
    }) + "\n",
  );
}

// Advisory only: never fail a session over a diagnostic.
main().catch(() => {}).finally(() => process.exit(0));
