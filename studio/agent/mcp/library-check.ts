// ---------------------------------------------------------------------------
// Is this session's library the one the studio serves?
// ---------------------------------------------------------------------------
// The check the extension makes at Pi's session_start, for harnesses that do
// not show the extension's notices: the agent writes to the library under the
// directory it was started in (or AVG_LIBRARY_ROOT), and when the gateway
// serves a different one, everything produced is invisible in the studio —
// silently, because from the agent's side nothing is wrong. Returns the
// warning, or null when there is nothing to say (a gateway that is not
// running is not news). Used by Claude Code's SessionStart hook
// (../claude/session-start.ts) and, for every other client, by the MCP server.
// ---------------------------------------------------------------------------

import { checkServiceHealth, resolveConfig } from "../src/config.js";

export async function libraryVisibilityWarning(): Promise<string | null> {
  try {
    const config = await resolveConfig();
    const { health } = await checkServiceHealth(config);
    const visibility = health["library-visibility"];
    if (!visibility || visibility.available) return null;
    return `Sergio: ${visibility.message}`;
  } catch {
    // Advisory only: never fail a session over a diagnostic.
    return null;
  }
}
