// ---------------------------------------------------------------------------
// The turns the studio's requests become, for agents that are not Pi
// ---------------------------------------------------------------------------
// Pi takes the intent router's requests as RPC methods. An agent driven
// through a conversation (Claude through the Claude Agent SDK, Codex, Gemini
// CLI, OpenCode, Goose, … through the Agent Client Protocol) takes them as
// turns, in these words. Shared so every such backend says the same thing.
// ---------------------------------------------------------------------------

import type { GatewayEvent } from "../events/bus.js";

function parts(episodeSlug: string): { channel: string; series: string; episode: string } {
  const [channel = "", series = "", episode = ""] = episodeSlug.split("/");
  return { channel, series, episode };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The turn a request asks for, or null for a request that is not a turn.
 * The method names are the ones the intent router sends Pi.
 */
export function turnFor(episodeSlug: string, method: string, params: Record<string, unknown>): string | null {
  const { channel, series, episode } = parts(episodeSlug);
  const target = `channel "${channel}", series "${series}", episode "${episode}"`;
  switch (method) {
    case "pva_run_pipeline":
      return (
        `Production prompt from the operator for episode ${episodeSlug}:\n\n${str(params.prompt)}\n\n` +
        `Load the pva-executive-producer skill (pva_load_skill serves it to an agent without skills), then run the episode's pipeline with ` +
        `pva_run_pipeline (${target}) and work through its stages.`
      );
    case "pva_steer": {
      const stage = str(params.stageId);
      return `Operator guidance for episode ${episodeSlug}${stage ? ` (stage "${stage}")` : ""}:\n\n${str(params.guidance)}`;
    }
    case "pva_follow_up": {
      const thread = str(params.threadId);
      return `The operator answered${thread ? ` (thread ${thread})` : ""}, about episode ${episodeSlug}:\n\n${str(params.response)}`;
    }
    case "pva_plan_rerun": {
      const stages = Array.isArray(params.stageIds) ? params.stageIds.map(String).join(", ") : "";
      return (
        `The operator asked for a rerun of episode ${episodeSlug}: mode "${str(params.mode) || "retry-current"}"` +
        `${stages ? `, stages ${stages}` : ""}. Plan it with pva_plan_rerun (${target}) and report the plan; ` +
        `run nothing until the operator confirms.`
      );
    }
    case "pva_artifact_changed":
      return (
        `The operator edited ${str(params.artifactPath)} in episode ${episodeSlug}, in the studio. ` +
        `Read it again before relying on an earlier version.`
      );
    default:
      return null;
  }
}

/** The turn review activity starts — the words the extension uses under Pi. */
export function reviewTurn(event: GatewayEvent): string | null {
  if (event.channel !== "review") return null;
  if (event.type === "thread-created") {
    return `New review activity just arrived: New review thread on "${str(event.data.anchor)}". ` +
      `Please call pva_journal to read the latest reviews and respond to the operator's feedback.`;
  }
  if (event.type === "message-added" && event.data.author === "operator") {
    return `New review activity just arrived: New operator comment in review thread. ` +
      `Please call pva_journal to read the latest reviews and respond to the operator's feedback.`;
  }
  return null;
}
