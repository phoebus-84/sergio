// ---------------------------------------------------------------------------
// Agent sessions over the Agent Client Protocol (ACP)
// ---------------------------------------------------------------------------
// The backend behind AgentSessionManager for every agent that speaks ACP
// (https://agentclientprotocol.com) on stdio: Codex (through its ACP
// adapter), Gemini CLI, OpenCode, Goose, Qwen Code, GitHub Copilot CLI,
// Cursor's CLI, Kiro, or any other, named by AVG_AGENT_BACKEND and, for one without a preset,
// AVG_ACP_COMMAND.
//
// Each episode gets one agent process and one ACP session in it. The intents
// the studio sends become prompt turns, one at a time, in the words the Claude
// backend uses (./turns.ts); review activity becomes a turn; cancel sends
// session/cancel. The production tools are the studio extension's, served by
// studio/agent/mcp/server.ts — the same code Pi loads — handed to the agent in
// session/new, so the gateway stays a bridge: it produces nothing itself.
//
// What the session does goes to the event bus on the "pi" channel (the
// agent's channel, whichever agent it is), named like Pi's own events:
// agent_start, message_end, tool_execution_start, agent_end, and
// session-created / session-ready / session-closed. Every event carries the
// backend's name.
//
// Nobody is there to answer a permission request, so the gateway answers it
// from a policy (AVG_ACP_ALLOWED_KINDS): by default what Pi has — reading,
// editing, searching, the shell and the studio's tools — and no web fetches.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type * as Acp from "@agentclientprotocol/sdk";
import { createEvent, type EventBus, type EventSubscriber } from "../events/bus.js";
import type { AgentSessionManager } from "./agent-sessions.js";
import { resolveRepoRoot } from "./claude-manager.js";
import { piSpawnEnv } from "./client.js";
import type { SessionHandle, SessionIdentity } from "./process-manager.js";
import { reviewTurn, turnFor } from "./turns.js";

// ── Which agent ─────────────────────────────────────────────────────────────

export interface AcpPreset {
  /** The agent's name as people read it. */
  label: string;
  /** The command that starts it speaking ACP on stdio. */
  command: string[];
  /** Where to read how to install and log in. */
  docs: string;
}

/**
 * Agents with a known ACP command. Each uses its own login (or API key) of
 * the user running the gateway; AVG_ACP_COMMAND replaces the command.
 */
export const ACP_PRESETS = {
  codex: {
    label: "Codex",
    command: ["npx", "-y", "@agentclientprotocol/codex-acp"],
    docs: "https://github.com/agentclientprotocol/codex-acp",
  },
  gemini: {
    label: "Gemini",
    command: ["gemini", "--acp"],
    docs: "https://github.com/google-gemini/gemini-cli",
  },
  opencode: {
    label: "OpenCode",
    command: ["opencode", "acp"],
    docs: "https://opencode.ai/docs/acp/",
  },
  goose: {
    label: "Goose",
    command: ["goose", "acp"],
    docs: "https://block.github.io/goose/",
  },
  qwen: {
    label: "Qwen Code",
    command: ["qwen", "--acp"],
    docs: "https://github.com/QwenLM/qwen-code",
  },
  copilot: {
    label: "Copilot",
    command: ["copilot", "--acp"],
    docs: "https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli",
  },
  cursor: {
    label: "Cursor",
    command: ["cursor-agent", "acp"],
    docs: "https://cursor.com/docs/cli/acp",
  },
  kiro: {
    label: "Kiro",
    command: ["kiro-cli", "acp"],
    docs: "https://kiro.dev/docs/cli/",
  },
} as const satisfies Record<string, AcpPreset>;

export type AcpPresetName = keyof typeof ACP_PRESETS;

export function isAcpPreset(name: string): name is AcpPresetName {
  return Object.prototype.hasOwnProperty.call(ACP_PRESETS, name);
}

/**
 * Split a command line into words: whitespace separates, single and double
 * quotes group, a backslash escapes the next character. A JSON array is taken
 * as it is.
 */
export function splitCommand(line: string): string[] {
  const text = line.trim();
  if (text.startsWith("[")) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every((w) => typeof w === "string")) {
      throw new Error("AVG_ACP_COMMAND as JSON must be an array of strings");
    }
    return parsed;
  }
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`AVG_ACP_COMMAND has an unclosed ${quote}`);
  if (inWord) words.push(word);
  return words;
}

export interface AcpAgentSpec {
  /** The backend's name, as AVG_AGENT_BACKEND gave it ("codex", "gemini", …, "acp"). */
  backend: string;
  label: string;
  command: string[];
  /** Where to read how to install the agent and log in, when it has a preset. */
  docs?: string;
}

/** The agent AVG_AGENT_BACKEND and AVG_ACP_COMMAND name. */
export function acpAgentFrom(backend: string, env: NodeJS.ProcessEnv = process.env): AcpAgentSpec {
  const preset = isAcpPreset(backend) ? ACP_PRESETS[backend] : null;
  const override = env.AVG_ACP_COMMAND?.trim();
  const command = override ? splitCommand(override) : preset ? [...preset.command] : [];
  if (command.length === 0) {
    throw new Error(
      `AVG_AGENT_BACKEND=${backend} needs AVG_ACP_COMMAND: the command that starts the agent speaking ACP on stdio ` +
        `(for example "opencode acp"). Known agents: ${Object.keys(ACP_PRESETS).join(", ")}.`,
    );
  }
  const label = env.AVG_ACP_LABEL?.trim() || preset?.label || command[0]!.split("/").pop()!;
  return { backend, label, command, ...(preset ? { docs: preset.docs } : {}) };
}

// ── Permission policy ───────────────────────────────────────────────────────

/** ACP's tool kinds the headless session allows by default: what Pi has, without the web. */
export const DEFAULT_ALLOWED_KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "switch_mode", "other"];

/** The kinds AVG_ACP_ALLOWED_KINDS names ("*" for all), or the default. */
export function allowedKindsFrom(env: NodeJS.ProcessEnv = process.env): Set<string> | "all" {
  const value = env.AVG_ACP_ALLOWED_KINDS?.trim();
  if (!value) return new Set(DEFAULT_ALLOWED_KINDS);
  if (value === "*") return "all";
  return new Set(value.split(",").map((k) => k.trim()).filter(Boolean));
}

/** Whether a tool call of this kind is allowed (a call with no kind counts as "other"). */
export function kindAllowed(kind: string | null | undefined, allowed: Set<string> | "all"): boolean {
  return allowed === "all" || allowed.has(kind ?? "other");
}

/**
 * The answer to a permission request: allow once when the tool's kind is
 * allowed, else reject once. An agent that offers no matching option is told
 * the request was cancelled, which no agent takes as a yes.
 */
export function permissionOutcome(
  request: Pick<Acp.RequestPermissionRequest, "toolCall" | "options">,
  allowed: Set<string> | "all",
): Acp.RequestPermissionResponse {
  const preferred: Acp.PermissionOptionKind[] = kindAllowed(request.toolCall.kind, allowed)
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
  for (const want of preferred) {
    const option = request.options.find((o) => o.kind === want);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

// ── The agent process ───────────────────────────────────────────────────────

/** A running agent, as the manager needs it: something the ACP client connects to. */
export interface AcpAgentProcess {
  /** A stdio stream, or (in tests) an in-process agent app. */
  target: Acp.Stream | Parameters<Acp.ClientApp["connect"]>[0];
  /** Resolves when the process ends. */
  exited: Promise<void>;
  kill(): void;
  /** The last lines it wrote to stderr, for an error message. */
  stderrTail(): string;
  pid: number | null;
}

export type SpawnAgentFn = (spec: { command: string[]; cwd: string; env: Record<string, string> }) => AcpAgentProcess;

const STDERR_KEEP = 4000;

/** Start the agent as a child process and speak ACP over its stdio. */
export const spawnAgentProcess: SpawnAgentFn = ({ command, cwd, env }) => {
  const [bin, ...args] = command;
  const child = spawn(bin!, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf-8")).slice(-STDERR_KEEP);
  });
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
    child.once("error", (err) => {
      stderr += `\n${err.message}`;
      resolveExit();
    });
  });
  // Loaded lazily so a gateway on Pi or Claude never imports the SDK.
  let target: Acp.Stream | null = null;
  return {
    get target() {
      if (!target) {
        target = acpModule().ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        );
      }
      return target;
    },
    exited,
    kill: () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    },
    stderrTail: () => stderr.trim(),
    pid: child.pid ?? null,
  };
};

let acpLoaded: typeof Acp | null = null;
function acpModule(): typeof Acp {
  if (!acpLoaded) throw new Error("the ACP SDK is not loaded yet");
  return acpLoaded;
}
async function loadAcp(): Promise<typeof Acp> {
  acpLoaded ??= await import("@agentclientprotocol/sdk");
  return acpLoaded;
}

// ── A session ───────────────────────────────────────────────────────────────

class AcpSession {
  readonly identity: SessionIdentity;
  lastActive = Date.now();
  alive = true;
  busy = false;
  acpSessionId: string | null = null;
  private connection: Acp.ClientConnection | null = null;
  private readonly queue: Array<{ text: string; origin: string }> = [];
  private running = false;
  /** While session/load replays the history, its updates are not news. */
  private replaying = false;
  /** Agent text of the turn in progress, published when a tool starts or the turn ends. */
  private text = "";
  private costUsd: number | undefined;
  private readonly subscriptions = new Map<string, Array<(data: Record<string, unknown>) => void>>();

  constructor(
    readonly episodeSlug: string,
    private readonly agent: AcpAgentProcess,
    private readonly publish: (type: string, data: Record<string, unknown>) => void,
    private readonly stateDir: string,
  ) {
    const now = new Date().toISOString();
    this.identity = {
      sessionId: `acp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      episodeSlug,
      pid: agent.pid,
      createdAt: now,
      lastActiveAt: now,
    };
  }

  /** Connect, initialize and open (or reload) the ACP session. */
  async open(
    acp: typeof Acp,
    params: { cwd: string; mcpServers: Acp.McpServer[]; resume: string | null; allowed: Set<string> | "all" },
  ): Promise<void> {
    const app = acp
      .client({ name: "sergio-gateway" })
      .onNotification(acp.methods.client.session.update, ({ params: note }) => this.update(note))
      .onRequest(acp.methods.client.session.requestPermission, ({ params: request }) => {
        if (!kindAllowed(request.toolCall.kind, params.allowed)) {
          this.emit("permission_denied", { toolName: request.toolCall.title ?? null, kind: request.toolCall.kind ?? "other" });
        }
        return permissionOutcome(request, params.allowed);
      });
    const connection = app.connect(this.agent.target as Acp.Stream);
    this.connection = connection;
    void connection.closed.then(() => this.close());

    const init = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "sergio-gateway", title: "Sergio", version: "0.1.0" },
    });

    if (params.resume && init.agentCapabilities?.loadSession) {
      this.replaying = true;
      try {
        await connection.agent.request(acp.methods.agent.session.load, {
          sessionId: params.resume,
          cwd: params.cwd,
          mcpServers: params.mcpServers,
        });
        this.acpSessionId = params.resume;
      } catch {
        // The agent no longer has it: start a new conversation.
      } finally {
        this.replaying = false;
      }
    }
    if (!this.acpSessionId) {
      const created = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: params.cwd,
        mcpServers: params.mcpServers,
      });
      this.acpSessionId = created.sessionId;
    }

    this.emit("session-ready", {
      acpSessionId: this.acpSessionId,
      agent: init.agentInfo?.title ?? init.agentInfo?.name ?? null,
      agentVersion: init.agentInfo?.version ?? null,
      protocolVersion: init.protocolVersion,
      resumed: this.acpSessionId === params.resume,
    });
    void this.drain();
  }

  send(text: string, origin: string): void {
    if (!this.alive) throw new Error("the session is closed");
    this.touch();
    this.queue.push({ text, origin });
    this.busy = true;
    this.publish("agent_start", { origin });
    void this.drain();
  }

  async interrupt(): Promise<void> {
    if (this.connection && this.acpSessionId) {
      await this.connection.agent.notify("session/cancel", { sessionId: this.acpSessionId });
    }
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    this.queue.length = 0;
    this.connection?.close();
    this.agent.kill();
    rmSync(this.stateDir, { recursive: true, force: true });
  }

  onEvent(type: string, handler: (data: Record<string, unknown>) => void): () => void {
    const list = this.subscriptions.get(type) ?? [];
    list.push(handler);
    this.subscriptions.set(type, list);
    return () => {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  }

  emit(type: string, data: Record<string, unknown>): void {
    for (const handler of this.subscriptions.get(type) ?? []) {
      try { handler(data); } catch { /* a subscriber's problem */ }
    }
    this.publish(type, data);
  }

  touch(): void {
    this.lastActive = Date.now();
    this.identity.lastActiveAt = new Date().toISOString();
  }

  /** Run queued turns one after another: ACP takes one prompt at a time. */
  private async drain(): Promise<void> {
    if (this.running || !this.connection || !this.acpSessionId) return;
    this.running = true;
    try {
      while (this.alive && this.queue.length > 0) {
        const turn = this.queue.shift()!;
        this.text = "";
        this.costUsd = undefined;
        try {
          const result = await this.connection.agent.request("session/prompt", {
            sessionId: this.acpSessionId,
            prompt: [{ type: "text", text: turn.text }],
          });
          this.flushText();
          this.emit("agent_end", {
            isError: result.stopReason === "refusal",
            subtype: result.stopReason,
            ...(this.costUsd !== undefined ? { costUsd: this.costUsd } : {}),
          });
        } catch (err) {
          this.flushText();
          if (!this.alive) return;
          const tail = this.agent.stderrTail();
          this.emit("agent_end", {
            isError: true,
            subtype: "error",
            error: (err instanceof Error ? err.message : String(err)) + (tail ? `\n${tail.split("\n").slice(-5).join("\n")}` : ""),
          });
        }
        this.touch();
      }
    } finally {
      this.running = false;
      this.busy = this.queue.length > 0;
    }
  }

  private flushText(): void {
    const text = this.text.trim();
    this.text = "";
    if (text) this.emit("message_end", { text, subagent: false });
  }

  private update(note: Acp.SessionNotification): void {
    if (this.replaying || note.sessionId !== this.acpSessionId) return;
    this.touch();
    const update = note.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") this.text += update.content.text;
        return;
      case "tool_call":
        this.flushText();
        this.emit("tool_execution_start", {
          toolName: update.title,
          toolUseId: update.toolCallId,
          kind: update.kind ?? "other",
        });
        return;
      case "usage_update":
        if (update.cost && update.cost.currency.toUpperCase() === "USD") this.costUsd = update.cost.amount;
        return;
      default:
        return;
    }
  }
}

// ── The manager ─────────────────────────────────────────────────────────────

export interface AcpManagerOptions {
  /** The library the gateway serves; the agent's tools write there. */
  libraryRoot: string;
  bus: EventBus;
  /** Which agent, and how to start it. */
  agent: AcpAgentSpec;
  /** Repository root: where AGENTS.md, the skills and the MCP server live. Resolved when omitted. */
  repoRoot?: string;
  idleTimeoutMs?: number;
  maxProcesses?: number;
  evictionScanMs?: number;
  /** Starts the agent; injected by tests. */
  spawnAgent?: SpawnAgentFn;
  env?: NodeJS.ProcessEnv;
}

/** Variables naming a harness session a process runs in; never passed on. */
const INHERITED_SESSION_ENV = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CODEX_THREAD_ID"];

export class AcpSessionManager implements AgentSessionManager {
  readonly backend: string;
  readonly label: string;
  private readonly sessions = new Map<string, AcpSession>();
  /** ACP session ids by episode, so a session evicted while idle reloads its conversation. */
  private readonly resumable = new Map<string, string>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private reviewSubscriber: EventSubscriber | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly idleTimeoutMs: number;
  private readonly maxProcesses: number;
  private readonly evictionScanMs: number;
  private readonly spawnAgent: SpawnAgentFn;

  constructor(private readonly options: AcpManagerOptions) {
    this.backend = options.agent.backend;
    this.label = options.agent.label;
    this.env = options.env ?? process.env;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
    this.maxProcesses = options.maxProcesses ?? 4;
    this.evictionScanMs = options.evictionScanMs ?? 60_000;
    this.spawnAgent = options.spawnAgent ?? spawnAgentProcess;
  }

  start(): void {
    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(() => this.evictIdle(), this.evictionScanMs);
      this.evictionTimer.unref?.();
    }
    if (!this.reviewSubscriber) {
      // Under Pi the extension hears review activity over the gateway's
      // WebSocket and starts a turn. Here the gateway is the one that hears it.
      let open = true;
      this.reviewSubscriber = {
        channels: ["review"],
        isAlive: () => open,
        close: () => { open = false; },
        send: (event) => {
          const text = reviewTurn(event);
          const session = event.episodeSlug ? this.sessions.get(event.episodeSlug) : undefined;
          if (text && session?.alive) session.send(text, "review");
        },
      };
      this.options.bus.subscribe(this.reviewSubscriber);
    }
  }

  async stop(): Promise<void> {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    if (this.reviewSubscriber) {
      this.reviewSubscriber.close();
      this.options.bus.unsubscribe(this.reviewSubscriber);
      this.reviewSubscriber = null;
    }
    for (const slug of [...this.sessions.keys()]) await this.shutdownSession(slug);
  }

  async session(episodeSlug: string): Promise<SessionHandle> {
    const existing = this.sessions.get(episodeSlug);
    if (existing?.alive) {
      existing.touch();
      return this.handle(existing);
    }
    if (existing) this.sessions.delete(episodeSlug);

    if (this.sessions.size >= this.maxProcesses) this.evictOne();

    const acp = await loadAcp();
    const repoRoot = this.options.repoRoot ?? resolveRepoRoot();
    const stateDir = mkdtempSync(join(tmpdir(), "pva-acp-"));
    const env = this.agentEnv(stateDir);
    const agent = this.spawnAgent({ command: this.options.agent.command, cwd: repoRoot, env });
    const session = new AcpSession(
      episodeSlug,
      agent,
      (type, data) => this.options.bus.publish(createEvent("pi", type, { backend: this.backend, episodeSlug, ...data }, episodeSlug)),
      stateDir,
    );
    this.sessions.set(episodeSlug, session);

    const ended = () => {
      if (session.acpSessionId) this.resumable.set(episodeSlug, session.acpSessionId);
      session.close();
      if (this.sessions.get(episodeSlug) === session) {
        this.sessions.delete(episodeSlug);
        this.options.bus.publish(createEvent("pi", "session-closed", { backend: this.backend, episodeSlug, sessionId: session.identity.sessionId }, episodeSlug));
      }
    };
    void agent.exited.then(ended);

    this.options.bus.publish(createEvent("pi", "session-created", {
      backend: this.backend,
      episodeSlug,
      sessionId: session.identity.sessionId,
      pid: agent.pid,
    }, episodeSlug));

    try {
      await session.open(acp, {
        cwd: repoRoot,
        mcpServers: [this.mcpServer(repoRoot, env)],
        resume: this.resumable.get(episodeSlug) ?? null,
        allowed: allowedKindsFrom(this.env),
      });
    } catch (err) {
      const tail = agent.stderrTail();
      ended();
      throw new Error(
        `${this.label} did not start an ACP session (${this.options.agent.command.join(" ")}): ` +
          `${err instanceof Error ? err.message : String(err)}${tail ? `\n${tail.split("\n").slice(-5).join("\n")}` : ""}` +
          `\nThe agent runs as the user who started the gateway, with that user's login or API key` +
          `${this.options.agent.docs ? ` (${this.options.agent.docs})` : ""}.`,
      );
    }
    return this.handle(session);
  }

  get(episodeSlug: string): SessionHandle | null {
    const session = this.sessions.get(episodeSlug);
    if (!session?.alive) return null;
    session.touch();
    return this.handle(session);
  }

  listSessions(): SessionIdentity[] {
    return [...this.sessions.values()].filter((s) => s.alive).map((s) => ({ ...s.identity }));
  }

  async shutdownSession(episodeSlug: string): Promise<void> {
    const session = this.sessions.get(episodeSlug);
    if (!session) return;
    this.sessions.delete(episodeSlug);
    if (session.acpSessionId) this.resumable.set(episodeSlug, session.acpSessionId);
    session.close();
    this.options.bus.publish(createEvent("pi", "session-closed", { backend: this.backend, episodeSlug, sessionId: session.identity.sessionId }, episodeSlug));
  }

  get activeSessions(): number {
    return [...this.sessions.values()].filter((s) => s.alive).length;
  }

  /**
   * The agent's environment: the one Pi gets (no operator key, headless),
   * pointed at the library this gateway serves and at a state directory of
   * its own. Exposed for tests.
   */
  agentEnv(stateDir: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(piSpawnEnv(this.env))) {
      if (value !== undefined) env[key] = value;
    }
    // A gateway started from inside another agent's session would otherwise
    // hand that session's identity to every episode's agent.
    for (const key of INHERITED_SESSION_ENV) delete env[key];
    env.AVG_LIBRARY_ROOT = this.options.libraryRoot;
    env.AVG_CLAUDE_STATE_DIR = stateDir;
    // Nobody types a prompt here, so no hook could deliver the inbox: the
    // MCP server appends it to tool results.
    env.AVG_MCP_INBOX = "tool-result";
    return env;
  }

  /** The studio's MCP server, as session/new hands it to the agent. Exposed for tests. */
  mcpServer(repoRoot: string, env: Record<string, string>): Acp.McpServerStdio {
    return {
      name: "pva",
      command: process.execPath,
      // ACP gives an MCP server no working directory: the launcher finds tsx
      // from where it lives, and AVG_LIBRARY_ROOT names the library.
      args: [join(repoRoot, "studio", "agent", "mcp", "start.mjs")],
      env: Object.entries(env).map(([name, value]) => ({ name, value })),
    };
  }

  private handle(session: AcpSession): SessionHandle {
    return {
      identity: { ...session.identity },
      request: async (method, params = {}) => {
        session.touch();
        if (method === "pva_version" || method === "health") {
          return {
            backend: this.backend,
            sessionId: session.identity.sessionId,
            acpSessionId: session.acpSessionId,
            busy: session.busy,
          };
        }
        if (method === "pva_cancel") {
          await session.interrupt();
          session.emit("agent_cancelled", {});
          return { cancelled: true, sessionId: session.identity.sessionId };
        }
        const text = turnFor(session.episodeSlug, method, params);
        if (!text) throw new Error(`The ${this.label} session takes no "${method}" request`);
        session.send(text, method);
        return { accepted: true, sessionId: session.identity.sessionId, acpSessionId: session.acpSessionId };
      },
      notify: (method, params = {}) => {
        // pva_review_added is not turned into a turn here: the review routes
        // publish the same activity on the bus, which start() already turns
        // into one. Doing both would ask the agent twice.
        const text = method === "pva_review_added" ? null : turnFor(session.episodeSlug, method, params);
        if (text && session.alive) session.send(text, method);
      },
      onEvent: (type, handler) => session.onEvent(type, handler),
      shutdown: () => this.shutdownSession(session.episodeSlug),
      isAlive: () => session.alive,
    };
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [slug, session] of this.sessions) {
      if (!session.busy && now - session.lastActive > this.idleTimeoutMs) void this.shutdownSession(slug);
    }
  }

  private evictOne(): void {
    let oldest: AcpSession | null = null;
    for (const session of this.sessions.values()) {
      if (session.busy) continue;
      if (!oldest || session.lastActive < oldest.lastActive) oldest = session;
    }
    if (oldest) void this.shutdownSession(oldest.episodeSlug);
  }
}
