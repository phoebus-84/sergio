// ---------------------------------------------------------------------------
// ACP agent sessions: Codex, Gemini CLI, OpenCode, … behind the same interface as Pi
// ---------------------------------------------------------------------------
// The agent is an in-process ACP agent app that answers each prompt from a
// script, so these run without any model: what is under test is what the
// gateway sends the agent, how it answers permission requests and what it
// publishes. The last test starts a stand-in agent as a real process, which
// starts the studio's real MCP server from what session/new handed it.

import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { EventBus, createEvent, type GatewayEvent } from "../src/events/bus.js";
import {
  AcpSessionManager,
  acpAgentFrom,
  allowedKindsFrom,
  permissionOutcome,
  splitCommand,
  type AcpAgentProcess,
  type SpawnAgentFn,
} from "../src/rpc/acp-manager.js";
import { handleIntent } from "../src/rpc/intent-router.js";

const SLUG = "ch/series/ep";
const REPO = resolve(__dirname, "..", "..", "..");

interface FakeAgent {
  spawned: Array<{ command: string[]; cwd: string; env: Record<string, string> }>;
  newSessions: acp.NewSessionRequest[];
  loads: acp.LoadSessionRequest[];
  prompts: string[];
  cancels: number;
  permissions: acp.RequestPermissionResponse[];
  killed: number;
}

/** An agent that answers every prompt with text, a tool call, two permission requests and a cost. */
function fakeAgent(): { spawn: SpawnAgentFn; state: FakeAgent } {
  const state: FakeAgent = { spawned: [], newSessions: [], loads: [], prompts: [], cancels: 0, permissions: [], killed: 0 };
  let sessions = 0;
  const spawn: SpawnAgentFn = (spec) => {
    state.spawned.push(spec);
    let exit!: () => void;
    const exited = new Promise<void>((r) => { exit = r; });
    const options = [
      { optionId: "yes", name: "Allow", kind: "allow_once" as const },
      { optionId: "always", name: "Always", kind: "allow_always" as const },
      { optionId: "no", name: "Reject", kind: "reject_once" as const },
    ];
    const app = acp
      .agent({ name: "fake" })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "fake", title: "Fake agent", version: "9" },
      }))
      .onRequest(acp.methods.agent.session.new, ({ params }) => {
        state.newSessions.push(params);
        sessions += 1;
        return { sessionId: `as-${sessions}` };
      })
      .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
        state.loads.push(params);
        // Replayed history, which the gateway must not publish as news.
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old reply" } },
        });
        return {};
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
        state.prompts.push(params.prompt.map((b) => (b.type === "text" ? b.text : "")).join(""));
        const update = (u: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: u });
        await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On " } });
        await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "it." } });
        await update({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "pva_journal", kind: "other", status: "pending" });
        state.permissions.push(await client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "tc1", title: "pva_journal", kind: "other" },
          options,
        }));
        state.permissions.push(await client.request(acp.methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "tc2", title: "Fetch https://example.com", kind: "fetch" },
          options,
        }));
        await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
        await update({ sessionUpdate: "usage_update", used: 100, size: 1000, cost: { amount: 0.02, currency: "USD" } });
        return { stopReason: "end_turn" };
      })
      .onNotification(acp.methods.agent.session.cancel, () => { state.cancels += 1; });
    const proc: AcpAgentProcess = {
      target: app,
      exited,
      kill: () => { state.killed += 1; exit(); },
      stderrTail: () => "",
      pid: null,
    };
    return proc;
  };
  return { spawn, state };
}

function collect(bus: EventBus): GatewayEvent[] {
  const events: GatewayEvent[] = [];
  bus.subscribe({ send: (e) => events.push(e), close: () => {}, isAlive: () => true });
  return events;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

let manager: AcpSessionManager | null = null;

afterEach(async () => {
  await manager?.stop();
  manager = null;
});

function make(env: NodeJS.ProcessEnv = { PATH: "/usr/bin" }, bus = new EventBus()) {
  const agent = fakeAgent();
  manager = new AcpSessionManager({
    libraryRoot: "/lib",
    bus,
    repoRoot: "/repo",
    agent: acpAgentFrom("codex", {}),
    spawnAgent: agent.spawn,
    env,
  });
  manager.start();
  return { manager, agent: agent.state, bus };
}

describe("which ACP agent", () => {
  it("has a preset for the agents it knows, and takes any other from AVG_ACP_COMMAND", () => {
    expect(acpAgentFrom("codex", {})).toMatchObject({ backend: "codex", label: "Codex", command: ["npx", "-y", "@agentclientprotocol/codex-acp"] });
    expect(acpAgentFrom("gemini", {}).command).toEqual(["gemini", "--acp"]);
    expect(acpAgentFrom("opencode", {}).command).toEqual(["opencode", "acp"]);
    expect(acpAgentFrom("goose", {}).command).toEqual(["goose", "acp"]);
    expect(acpAgentFrom("gemini", { AVG_ACP_COMMAND: "/opt/gemini --acp -m flash" }).command).toEqual(["/opt/gemini", "--acp", "-m", "flash"]);
    expect(acpAgentFrom("acp", { AVG_ACP_COMMAND: "my-agent --stdio" })).toEqual({ backend: "acp", label: "my-agent", command: ["my-agent", "--stdio"] });
    expect(acpAgentFrom("acp", { AVG_ACP_COMMAND: "my-agent", AVG_ACP_LABEL: "Mine" }).label).toBe("Mine");
    expect(() => acpAgentFrom("acp", {})).toThrow(/needs AVG_ACP_COMMAND/);
  });

  it("splits a command line as a shell would, quotes included", () => {
    expect(splitCommand(`npx -y "@scope/pkg" --name 'two words' a\\ b`)).toEqual(["npx", "-y", "@scope/pkg", "--name", "two words", "a b"]);
    expect(splitCommand(`["node", "agent.js", "--acp"]`)).toEqual(["node", "agent.js", "--acp"]);
    expect(splitCommand(`a "" b`)).toEqual(["a", "", "b"]);
    expect(() => splitCommand(`a "b`)).toThrow(/unclosed/);
  });
});

describe("permission policy", () => {
  const options = [
    { optionId: "a1", name: "Allow", kind: "allow_once" as const },
    { optionId: "r1", name: "Reject", kind: "reject_once" as const },
  ];

  it("allows what Pi has and rejects web fetches by default", () => {
    const allowed = allowedKindsFrom({});
    for (const kind of ["read", "edit", "execute", "search", "other", undefined] as const) {
      expect(permissionOutcome({ toolCall: { toolCallId: "t", kind }, options }, allowed)).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
    }
    expect(permissionOutcome({ toolCall: { toolCallId: "t", kind: "fetch" }, options }, allowed)).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it("takes the allowed kinds from AVG_ACP_ALLOWED_KINDS", () => {
    expect(permissionOutcome({ toolCall: { toolCallId: "t", kind: "fetch" }, options }, allowedKindsFrom({ AVG_ACP_ALLOWED_KINDS: "*" })).outcome).toEqual({ outcome: "selected", optionId: "a1" });
    expect(permissionOutcome({ toolCall: { toolCallId: "t", kind: "execute" }, options }, allowedKindsFrom({ AVG_ACP_ALLOWED_KINDS: "read, other" })).outcome).toEqual({ outcome: "selected", optionId: "r1" });
  });

  it("cancels rather than guess when no option fits", () => {
    expect(permissionOutcome({ toolCall: { toolCallId: "t", kind: "fetch" }, options: [options[0]!] }, allowedKindsFrom({}))).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("ACP sessions", () => {
  it("turns a steer intent into a prompt turn and publishes what the agent does", async () => {
    const { manager, agent, bus } = make();
    const events = collect(bus);

    const result = await handleIntent(
      { intent: "steer", episodeSlug: SLUG, stageId: "script", payload: { guidance: "Shorter intro" } },
      manager,
      bus,
    );
    expect(result.status).toBe("accepted");
    await settle();

    expect(agent.prompts).toEqual(["Operator guidance for episode ch/series/ep (stage \"script\"):\n\nShorter intro"]);
    const types = events.filter((e) => e.channel === "pi").map((e) => e.type);
    expect(types).toEqual([
      "session-created",
      "session-ready",
      "agent_start",
      "message_end",
      "tool_execution_start",
      "permission_denied",
      "message_end",
      "agent_end",
    ]);
    const texts = events.filter((e) => e.type === "message_end").map((e) => e.data.text);
    expect(texts).toEqual(["On it.", "Done."]);
    expect(events.find((e) => e.type === "tool_execution_start")!.data).toMatchObject({ backend: "codex", toolName: "pva_journal", toolUseId: "tc1" });
    expect(events.find((e) => e.type === "permission_denied")!.data).toMatchObject({ kind: "fetch" });
    expect(events.find((e) => e.type === "agent_end")!.data).toMatchObject({ backend: "codex", episodeSlug: SLUG, isError: false, subtype: "end_turn", costUsd: 0.02 });
    expect(events.find((e) => e.type === "session-ready")!.data).toMatchObject({ acpSessionId: "as-1", agent: "Fake agent", resumed: false });
    expect(agent.permissions).toEqual([
      { outcome: { outcome: "selected", optionId: "yes" } },
      { outcome: { outcome: "selected", optionId: "no" } },
    ]);
  });

  it("hands the agent the studio's MCP server, on the gateway's library, headless", async () => {
    const { manager, agent } = make({
      PATH: "/usr/bin",
      AVG_OPERATOR_KEY_FILE: "/secret/operator.key",
      CLAUDE_CODE_SESSION_ID: "parent-session",
    });
    await manager.session(SLUG);
    expect(agent.spawned[0]!.command).toEqual(["npx", "-y", "@agentclientprotocol/codex-acp"]);
    expect(agent.spawned[0]!.cwd).toBe("/repo");
    const request = agent.newSessions[0]!;
    expect(request.cwd).toBe("/repo");
    const pva = request.mcpServers[0] as acp.McpServerStdio;
    expect(pva.name).toBe("pva");
    expect(pva.command).toBe(process.execPath);
    expect(pva.args).toEqual(["/repo/studio/agent/mcp/start.mjs"]);
    const serverEnv = Object.fromEntries(pva.env.map((e) => [e.name, e.value]));
    for (const env of [agent.spawned[0]!.env, serverEnv]) {
      expect(env.AVG_LIBRARY_ROOT).toBe("/lib");
      expect(env.AVG_HEADLESS).toBe("1");
      expect(env.AVG_MCP_INBOX).toBe("tool-result");
      expect(env.AVG_OPERATOR_KEY_FILE).toBeUndefined();
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    }
  });

  it("keeps one session per episode and runs its turns one at a time, in order", async () => {
    const { manager, agent } = make();
    const a = await manager.session(SLUG);
    await a.request("pva_follow_up", { response: "Yes, use the blue one", threadId: "t1" });
    const b = await manager.session(SLUG);
    await b.request("pva_run_pipeline", { prompt: "A fairy tale about a fox" });
    await settle();
    expect(agent.spawned).toHaveLength(1);
    expect(agent.prompts[0]).toMatch(/^The operator answered \(thread t1\)/);
    expect(agent.prompts[1]).toMatch(/A fairy tale about a fox/);
    expect(agent.prompts[1]).toMatch(/pva_load_skill/);
    expect(manager.activeSessions).toBe(1);
  });

  it("sends session/cancel on cancel", async () => {
    const { manager, agent } = make();
    const session = await manager.session(SLUG);
    await expect(session.request("pva_cancel", {})).resolves.toMatchObject({ cancelled: true });
    await settle();
    expect(agent.cancels).toBe(1);
  });

  it("refuses a request that is not a turn", async () => {
    const { manager } = make();
    const session = await manager.session(SLUG);
    await expect(session.request("pva_nonsense", {})).rejects.toThrow(/Codex session takes no "pva_nonsense"/);
  });

  it("starts a turn on operator review activity, not on the agent's own replies", async () => {
    const { manager, agent, bus } = make();
    await manager.session(SLUG);
    bus.publish(createEvent("review", "thread-created", { threadId: "t1", anchor: "scene-2" }, SLUG));
    bus.publish(createEvent("review", "message-added", { threadId: "t1", author: "pi" }, SLUG));
    bus.publish(createEvent("review", "message-added", { threadId: "t1", author: "operator" }, SLUG));
    bus.publish(createEvent("review", "thread-created", { threadId: "t9", anchor: "elsewhere" }, "other/series/ep"));
    await settle();
    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[0]).toMatch(/New review thread on "scene-2".*pva_journal/);
    expect(agent.prompts[1]).toMatch(/operator comment/);
  });

  it("reloads the conversation after an idle session is shut down, without republishing it", async () => {
    const { manager, agent, bus } = make();
    await manager.session(SLUG);
    await manager.shutdownSession(SLUG);
    expect(agent.killed).toBe(1);
    expect(manager.activeSessions).toBe(0);
    const events = collect(bus);
    await manager.session(SLUG);
    expect(agent.spawned).toHaveLength(2);
    expect(agent.loads.map((l) => l.sessionId)).toEqual(["as-1"]);
    expect(agent.newSessions).toHaveLength(1);
    expect(events.filter((e) => e.type === "message_end")).toEqual([]);
    expect(events.find((e) => e.type === "session-ready")!.data).toMatchObject({ acpSessionId: "as-1", resumed: true });
  });

  it("closes the session when the agent exits", async () => {
    const { manager, bus } = make();
    const events = collect(bus);
    const session = await manager.session(SLUG);
    await session.shutdown();
    expect(session.isAlive()).toBe(false);
    expect(events.filter((e) => e.type === "session-closed")).toHaveLength(1);
  });
});

describe("a real agent process", () => {
  it("reaches the studio's tools through the MCP server session/new names", async () => {
    const bus = new EventBus();
    const events = collect(bus);
    manager = new AcpSessionManager({
      libraryRoot: resolve(REPO, ".test-tmp", "acp-library"),
      bus,
      repoRoot: REPO,
      agent: acpAgentFrom("acp", { AVG_ACP_COMMAND: `node ${resolve(__dirname, "fixtures", "fake-acp-agent.mjs")}`, AVG_ACP_LABEL: "Fake" }),
      env: { ...process.env, AVG_GATEWAY_URL: "http://127.0.0.1:9" },
    });
    manager.start();
    const session = await manager.session(SLUG);
    expect(session.identity.pid).toBeGreaterThan(0);
    await session.request("pva_steer", { guidance: "Call pva_version, please" });
    for (let i = 0; i < 200 && !events.some((e) => e.type === "agent_end"); i++) await new Promise((r) => setTimeout(r, 100));
    const end = events.find((e) => e.type === "agent_end")!;
    expect(end.data).toMatchObject({ backend: "acp", isError: false, subtype: "end_turn" });
    const reply = String(events.find((e) => e.type === "message_end")!.data.text);
    expect(reply).toMatch(/^pva serves \d{2,} tools; pva_version said/);
  }, 30_000);
});
