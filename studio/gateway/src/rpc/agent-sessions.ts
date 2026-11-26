// ---------------------------------------------------------------------------
// Agent sessions, whichever agent runs them
// ---------------------------------------------------------------------------
// The intent router, the UI bridge, health and the start route need one thing
// from the agent: a session per episode they can send requests to. Pi
// provides it (PiProcessManager, Pi RPC subprocesses); so does Claude
// (ClaudeSessionManager, the Claude Agent SDK); so does any agent that speaks
// the Agent Client Protocol — Codex, Gemini CLI, OpenCode, Goose, Qwen Code,
// Copilot CLI, Cursor, Kiro, … (AcpSessionManager). The gateway picks one with
// AVG_AGENT_BACKEND; Pi is the default.
// ---------------------------------------------------------------------------

import { ACP_PRESETS } from "./acp-manager.js";
import type { SessionHandle, SessionIdentity } from "./process-manager.js";

export type { SessionHandle, SessionIdentity };

/**
 * "pi", "claude", an ACP agent with a preset ("codex", "gemini", "opencode",
 * "goose", "qwen", "copilot", "cursor", "kiro"), or "acp" for any other (AVG_ACP_COMMAND).
 */
export type AgentBackend = string;

/** Every name AVG_AGENT_BACKEND takes. */
export const AGENT_BACKENDS = ["pi", "claude", ...Object.keys(ACP_PRESETS), "acp"];

export interface AgentSessionManager {
  /** Which agent this manager runs. */
  readonly backend: AgentBackend;
  /** The agent's name as people read it ("Pi", "Claude", "Codex", …). */
  readonly label: string;
  start(): void;
  stop(): Promise<void>;
  /** Get or create the session for an episode (`channel/series/episode`). */
  session(episodeSlug: string): Promise<SessionHandle>;
  /** An existing live session, without creating one. */
  get(episodeSlug: string): SessionHandle | null;
  listSessions(): SessionIdentity[];
  shutdownSession(episodeSlug: string): Promise<void>;
  readonly activeSessions: number;
}

/** The backend named by AVG_AGENT_BACKEND, defaulting to Pi. */
export function agentBackendFrom(env: NodeJS.ProcessEnv = process.env): AgentBackend {
  const value = (env.AVG_AGENT_BACKEND ?? "pi").trim().toLowerCase();
  if (value === "") return "pi";
  if (AGENT_BACKENDS.includes(value)) return value;
  throw new Error(`AVG_AGENT_BACKEND must be one of ${AGENT_BACKENDS.join(", ")}, not "${env.AVG_AGENT_BACKEND}"`);
}
