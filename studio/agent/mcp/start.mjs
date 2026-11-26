#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Start the studio's MCP server from any directory
// ---------------------------------------------------------------------------
// `node --import tsx studio/agent/mcp/server.ts` finds tsx in the directory it
// is started in, so it works only from the repository root. Some clients
// start MCP servers elsewhere: ACP agents (Codex, Gemini CLI, OpenCode, …,
// driven by the gateway) take no working directory for them, and an editor
// may start them in its own. This registers tsx from the repository the
// script lives in, then serves:
//
//   node /path/to/sergio/studio/agent/mcp/start.mjs
//
// The library is the one under the working directory, unless
// AVG_LIBRARY_ROOT names another (the gateway always does). Started somewhere
// with no library and no AVG_LIBRARY_ROOT, it moves to the repository root,
// where the docs put the library link — rather than serve a library that is
// not there.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { register } from "tsx/esm/api";

const root = resolve(import.meta.dirname, "..", "..", "..");
if (!process.env.AVG_LIBRARY_ROOT && !existsSync(join(process.cwd(), "library")) && process.cwd() !== root) {
  process.stderr.write(`[pva] no library under ${process.cwd()}; serving from the repository root, ${root}\n`);
  process.chdir(root);
}

register();
const { main } = await import("./server.ts");
await main();
