// ---------------------------------------------------------------------------
// Session-side files the MCP server shares with the harness around it
// ---------------------------------------------------------------------------
// Pi shows a status line and takes turns pushed by the extension. Other
// harnesses cannot be pushed a turn by an MCP server, so the server leaves
// what they need in a small directory:
//
//   <state>/status.json   what the extension last put in the status bar
//   <state>/inbox.jsonl   messages the extension wanted the agent to see,
//                         waiting to be delivered (one JSON per line)
//
// Who empties the inbox depends on the client: under Claude Code its
// UserPromptSubmit hook hands it to the next prompt; under any other client
// (Codex, Gemini CLI, Cursor, VS Code, OpenCode, …) the server itself appends
// it to the next pva tool result (see drain() and server.ts).
//
// <state> is $AVG_CLAUDE_STATE_DIR, else .claude/pva under the directory the
// session was started in. studio/agent/claude/*.mjs read the same files.
// ---------------------------------------------------------------------------

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface InboxEntry {
  at: string;
  kind: string;
  text: string;
}

/** Most a delivery should put in front of the agent; older entries are summarised by count. */
const MAX_CONTEXT_CHARS = 4000;

/**
 * The text for a set of inbox entries, newest kept when they do not all fit.
 * studio/agent/claude/inbox-hook.mjs writes the same shape (plain JS on
 * purpose: it runs on every prompt).
 */
export function inboxContext(entries: InboxEntry[], heading: string): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map((e) => `- [${e.kind ?? "studio"} ${e.at ?? ""}] ${e.text}`.replace(/\s+$/, ""));
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i]!.length > MAX_CONTEXT_CHARS && kept.length > 0) break;
    kept.unshift(lines[i]!);
    size += lines[i]!.length + 1;
  }
  const dropped = lines.length - kept.length;
  return [
    heading,
    ...(dropped > 0 ? [`- (${dropped} earlier entries omitted; pva_journal has the full record)`] : []),
    ...kept,
  ].join("\n");
}

export function stateDir(cwd: string = process.cwd(), env: Record<string, string | undefined> = process.env): string {
  return env.AVG_CLAUDE_STATE_DIR ? resolve(env.AVG_CLAUDE_STATE_DIR) : join(cwd, ".claude", "pva");
}

export class SessionState {
  private readonly status = new Map<string, string>();

  constructor(readonly dir: string) {}

  setStatus(key: string, text: string): void {
    if (text) this.status.set(key, text);
    else this.status.delete(key);
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, "status.json");
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), pid: process.pid, items: Object.fromEntries(this.status) }) + "\n");
      renameSync(tmp, file);
    } catch {
      // A status bar is a convenience; never fail a session over it.
    }
  }

  /** The status bar's current text, one line per key. */
  statusLines(): string[] {
    return [...this.status.values()];
  }

  clearStatus(): void {
    this.status.clear();
    this.setStatus("", "");
  }

  post(kind: string, text: string): void {
    const entry: InboxEntry = { at: new Date().toISOString(), kind, text };
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, "inbox.jsonl"), JSON.stringify(entry) + "\n");
    } catch {
      // Same: the journal (pva_journal) still holds the record.
    }
  }

  /** Take every waiting entry, leaving the inbox empty. */
  drain(): InboxEntry[] {
    const file = join(this.dir, "inbox.jsonl");
    if (!existsSync(file)) return [];
    // A rename is atomic: the next post starts a fresh file.
    const taken = `${file}.${process.pid}.taken`;
    try {
      renameSync(file, taken);
    } catch {
      return [];
    }
    try {
      return readFileSync(taken, "utf-8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const entry = JSON.parse(line) as InboxEntry;
            return typeof entry.text === "string" ? [entry] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    } finally {
      rmSync(taken, { force: true });
    }
  }
}
