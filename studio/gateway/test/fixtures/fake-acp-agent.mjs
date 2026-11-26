#!/usr/bin/env node
// A stand-in for an ACP agent (Codex, Gemini CLI, OpenCode, …), for the
// gateway's ACP backend tests: it speaks ACP on stdio, starts the MCP servers
// session/new hands it, as a real agent does, and answers each prompt by
// calling the first tool the prompt names on the "pva" server and saying what
// came back. No model is involved.

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcp = new Map();

async function startMcp(servers) {
  for (const server of servers) {
    const client = new Client({ name: "fake-acp-agent", version: "0" });
    await client.connect(new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map((e) => [e.name, e.value])),
      stderr: "ignore",
    }));
    mcp.set(server.name, client);
  }
}

const app = acp
  .agent({ name: "fake-acp-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "fake-acp-agent", title: "Fake", version: "0.0.1" },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params }) => {
    await startMcp(params.mcpServers);
    return { sessionId: "fake-session" };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    const pva = mcp.get("pva");
    const { tools } = await pva.listTools();
    const name = /\b(pva_[a-z_]+)/.exec(text)?.[1] ?? "pva_version";
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: name, kind: "other", status: "pending" },
    });
    const result = await pva.callTool({ name, arguments: {} });
    const first = result.content?.[0]?.type === "text" ? result.content[0].text : "";
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `pva serves ${tools.length} tools; ${name} said ${JSON.stringify(first.slice(0, 60))}` },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {});

const connection = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
for (const client of mcp.values()) await client.close().catch(() => {});
process.exit(0);
