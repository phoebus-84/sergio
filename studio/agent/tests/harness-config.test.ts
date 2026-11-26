/**
 * The project files each harness reads (ADR-0048): every one starts the same
 * MCP server, and the read-only tools that run without asking are the same in
 * Claude Code and in Codex.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");
const json = (path: string) => JSON.parse(read(path));
const SERVER = ["--import", "tsx", "studio/agent/mcp/server.ts"];

describe("harness project files", () => {
  it("start the studio's MCP server as pva, from the repository root", () => {
    expect(json(".mcp.json").mcpServers.pva).toMatchObject({ type: "stdio", command: "node", args: SERVER });
    expect(json(".gemini/settings.json").mcpServers.pva).toMatchObject({ command: "node", args: SERVER });
    expect(json(".cursor/mcp.json").mcpServers.pva).toEqual({ command: "node", args: ["${workspaceFolder}/studio/agent/mcp/start.mjs"] });
    const opencode = json("opencode.json").mcp;
    expect(opencode.pva).toMatchObject({ type: "local", command: ["node", ...SERVER], enabled: true });
    expect(opencode.servers.pva).toMatchObject({ type: "local", command: ["node", ...SERVER] });
    const codex = read(".codex/config.toml");
    expect(codex).toContain(`[mcp_servers.pva]\ncommand = "node"\nargs = ${JSON.stringify(SERVER).replace(/,/g, ", ")}`);
    expect(existsSync(join(ROOT, "studio/agent/mcp/start.mjs"))).toBe(true);
  });

  it("let Codex run without asking exactly the tools Claude Code runs without asking", () => {
    const claude = (json(".claude/settings.json").permissions.allow as string[]).map((t) => t.replace(/^mcp__pva__/, "")).sort();
    const codex = [...read(".codex/config.toml").matchAll(/^\[mcp_servers\.pva\.tools\.(\w+)\]\napproval_mode = "approve"$/gm)].map((m) => m[1]).sort();
    expect(codex).toEqual(claude);
  });

  it("point Gemini CLI at AGENTS.md, which CLAUDE.md imports", () => {
    expect(json(".gemini/settings.json").context.fileName).toEqual(["AGENTS.md"]);
    expect(read("CLAUDE.md").split("\n")[0]).toBe("@AGENTS.md");
  });
});
