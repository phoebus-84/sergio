/**
 * The extension served over MCP: what a client such as Claude Code sees.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPvaServer, inboxDeliveryFor, TOOL_RESULT_HEADING, type PvaServer } from "../mcp/server.js";
import { createModelRegistry, codexCliToken } from "../mcp/credentials.js";
import { createToolHost } from "../mcp/host.js";

const FIXTURE = new URL("./fixtures/mcp-extension.ts", import.meta.url).href;
const EXTENSION = new URL("../extensions/index.ts", import.meta.url).href;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pva-mcp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function connect(
  env: Record<string, string | undefined> = {},
  extension = FIXTURE,
  { clientName = "claude-code", libraryCheck = async () => null as string | null } = {},
) {
  const pva = await createPvaServer({
    extension,
    cwd: dir,
    env: { AVG_CLAUDE_STATE_DIR: join(dir, "state"), ...env },
    modelRegistry: createModelRegistry({ env, piRegistry: async () => null, codexCli: () => undefined }),
    log: () => {},
    libraryCheck,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: "0" });
  await pva.server.connect(serverSide);
  await client.connect(clientSide);
  return { pva, client };
}

function inbox(): Array<{ kind: string; text: string }> {
  const file = join(dir, "state", "inbox.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("MCP server: tools", () => {
  it("serves every tool the studio extension registers, with object schemas", async () => {
    const registered: string[] = [];
    const host = createToolHost({
      mode: "test",
      cwd: dir,
      modelRegistry: { getApiKeyForProvider: async () => undefined },
      notify: () => {},
      setStatus: () => {},
      message: () => {},
    });
    const factory = (await import(EXTENSION)).default as (api: unknown) => void;
    factory({ ...host.api, registerTool: (t: { name: string }) => { registered.push(t.name); (host.api.registerTool as (t: unknown) => void)(t); } });

    const { client } = await connect({}, EXTENSION);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...registered].sort());
    expect(tools.length).toBeGreaterThan(50);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description).toBeTruthy();
    }
  });

  it("runs a tool and returns its content", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "fx_echo", arguments: { text: "hello" } });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("turns a thrown error into an error result, as Pi does", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "fx_throw", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "the fixture failed on purpose" }]);
  });

  it("reports a tool's updates as progress when the client asks for it", async () => {
    const { client } = await connect();
    const messages: string[] = [];
    await client.callTool({ name: "fx_progress", arguments: {} }, undefined, {
      onprogress: (p) => { if (p.message) messages.push(p.message); },
    });
    expect(messages).toEqual(["first half", "second half"]);
  });
});

describe("MCP server: commands as prompts", () => {
  it("lists each slash command as a prompt with positional arguments", async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["go"]);
    expect(prompts[0]!.arguments?.[0]?.name).toBe("arg1");
  });

  it("returns the turn the command asks for, from the words it was given", async () => {
    const { client } = await connect();
    const prompt = await client.getPrompt({ name: "go", arguments: { arg1: "demo/s1/e1" } });
    expect(prompt.messages[0]!.content).toEqual({ type: "text", text: "Go to work on demo/s1/e1." });
  });

  it("keeps concurrent prompts apart", async () => {
    const { client } = await connect();
    const [a, b] = await Promise.all([
      client.getPrompt({ name: "go", arguments: { arg1: "a/b/c" } }),
      client.getPrompt({ name: "go", arguments: {} }),
    ]);
    expect(a.messages[0]!.content).toEqual({ type: "text", text: "Go to work on a/b/c." });
    expect((b.messages[0]!.content as { text: string }).text).toContain("Usage: /go");
  });

  it("does not leak a command's turn into the session", async () => {
    const { client } = await connect();
    await client.getPrompt({ name: "go", arguments: { arg1: "x/y/z" } });
    expect(inbox()).toEqual([]);
  });
});

describe("MCP server: what the extension pushes at the session", () => {
  it("queues review turns and stage updates in the inbox without a channel", async () => {
    const { client } = await connect();
    await client.callTool({ name: "fx_review", arguments: {} });
    expect(inbox().map((e) => [e.kind, e.text])).toEqual([
      ["review", "New review activity just arrived"],
      ["stage-update", "Stage \"brief\" completed"],
    ]);
  });

  it("sends review turns as channel events when AVG_CLAUDE_CHANNEL=1", async () => {
    const { client } = await connect({ AVG_CLAUDE_CHANNEL: "1" });
    expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });

    const events: unknown[] = [];
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === "notifications/claude/channel") events.push(n.params);
    };
    await client.callTool({ name: "fx_review", arguments: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([{ content: "New review activity just arrived", meta: { kind: "review" } }]);
    // Stage updates never ask for a turn, so they wait for the next prompt.
    expect(inbox().map((e) => e.kind)).toEqual(["stage-update"]);
  });

  it("declares no channel otherwise", async () => {
    const { client } = await connect();
    expect(client.getServerCapabilities()?.experimental).toBeUndefined();
  });

  it("writes the status bar on start and clears it on stop", async () => {
    const { pva } = await connect();
    await pva.start();
    const status = () => JSON.parse(readFileSync(join(dir, "state", "status.json"), "utf-8")).items;
    expect(status()).toEqual({ fixture: "fixture (mcp)" });
    await pva.stop();
    expect(status()).toEqual({});
  });
});

describe("MCP server: clients without Claude Code's hooks", () => {
  const texts = (result: object) => ((result as { content?: unknown }).content as Array<{ text: string }>).map((c) => c.text);

  it("hands the inbox to Claude Code's hook, and to tool results for every other client", () => {
    expect(inboxDeliveryFor("claude-code", {})).toBe("hook");
    for (const name of ["codex-mcp-client", "gemini-cli-mcp-client", "cursor-vscode", "Visual Studio Code", "opencode", "goose", "zed"]) {
      expect(inboxDeliveryFor(name, {})).toBe("tool-result");
    }
    expect(inboxDeliveryFor("claude-code", { AVG_MCP_INBOX: "tool-result" })).toBe("tool-result");
    expect(inboxDeliveryFor("codex-mcp-client", { AVG_MCP_INBOX: "hook" })).toBe("hook");
  });

  it("appends review turns and stage updates to the tool result, once", async () => {
    const { pva, client } = await connect({}, FIXTURE, { clientName: "codex-mcp-client" });
    expect(pva.delivery()).toBe("tool-result");
    const pushed = await client.callTool({ name: "fx_review", arguments: {} });
    const [result, activity] = texts(pushed);
    expect(result).toBe("pushed");
    expect(activity).toContain(TOOL_RESULT_HEADING);
    expect(activity).toContain("New review activity just arrived");
    expect(activity).toContain("[stage-update");
    expect(inbox()).toEqual([]);

    const next = await client.callTool({ name: "fx_echo", arguments: { text: "hi" } });
    expect(texts(next)).toEqual(["hi"]);
  });

  it("leaves the inbox to the hook under Claude Code", async () => {
    const { pva, client } = await connect();
    expect(pva.delivery()).toBe("hook");
    const pushed = await client.callTool({ name: "fx_review", arguments: {} });
    expect(texts(pushed)).toEqual(["pushed"]);
    expect(inbox()).toHaveLength(2);
  });

  it("says in the first tool result when the studio cannot see this library", async () => {
    const warning = "Sergio: the gateway serves /elsewhere, not this library";
    const { client } = await connect({}, FIXTURE, { clientName: "gemini-cli-mcp-client", libraryCheck: async () => warning });
    await new Promise((r) => setTimeout(r, 20));
    const first = await client.callTool({ name: "fx_echo", arguments: { text: "hi" } });
    expect(texts(first)[1]).toContain(warning);
    expect(texts(await client.callTool({ name: "fx_echo", arguments: { text: "again" } }))).toEqual(["again"]);
  });

  it("does not run the library check for Claude Code, whose SessionStart hook does", async () => {
    let checked = false;
    await connect({}, FIXTURE, { libraryCheck: async () => { checked = true; return "x"; } });
    await new Promise((r) => setTimeout(r, 20));
    expect(checked).toBe(false);
  });
});

describe("MCP server: credentials", () => {
  it("gives tools the Codex token from AVG_CODEX_TOKEN", async () => {
    const { client } = await connect({ AVG_CODEX_TOKEN: "tok" });
    const result = await client.callTool({ name: "fx_codex", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "token:tok" }]);
  });

  it("prefers Pi's login, then the Codex CLI's", async () => {
    const fromPi = createModelRegistry({ env: {}, piRegistry: async () => ({ getApiKeyForProvider: async () => "pi" }), codexCli: () => "cli" });
    expect(await fromPi.getApiKeyForProvider("openai-codex")).toBe("pi");
    const fromCli = createModelRegistry({ env: {}, piRegistry: async () => ({ getApiKeyForProvider: async () => undefined }), codexCli: () => "cli" });
    expect(await fromCli.getApiKeyForProvider("openai-codex")).toBe("cli");
    expect(await fromCli.getApiKeyForProvider("anthropic")).toBeUndefined();
  });

  it("reads the Codex CLI login and ignores an expired token", () => {
    const home = join(dir, "codex");
    mkdirSync(home);
    const jwt = (exp: number) =>
      `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
    const now = Date.UTC(2026, 0, 1);
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: jwt(now / 1000 + 3600) } }));
    expect(codexCliToken({ CODEX_HOME: home }, now)).toBe(jwt(now / 1000 + 3600));
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: jwt(now / 1000 - 1) } }));
    expect(codexCliToken({ CODEX_HOME: home }, now)).toBeUndefined();
    expect(codexCliToken({ CODEX_HOME: join(dir, "missing") }, now)).toBeUndefined();
  });
});

// Keep the type import used: PvaServer is the public shape these tests drive.
export type { PvaServer };
