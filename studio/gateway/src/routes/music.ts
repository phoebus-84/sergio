// ---------------------------------------------------------------------------
// Music written as code (ADR-0053)
// ---------------------------------------------------------------------------
// The pieces of a workspace (music/*.strudel) and what was rendered from them,
// a check of a piece, and a render started by a person from the studio.
//
// The work itself is @studio/episode's, the same code the agent's tools call:
// the gateway carries the request there (ADR-0027) and writes nothing of its
// own. It keeps the renders it started, so that a second request for the same
// workspace does not run beside the first.
//
// A workspace is the level the route names (a channel or a film, a series or a
// scene, an episode or a shot), or with `within` a directory under it: a
// channel's source is `within=sources/<name>`.
// ---------------------------------------------------------------------------

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync, statSync } from "node:fs";
import { MusicError, checkMusic, listMusic, musicReadiness, renderMusic, type MusicCheckRequest, type MusicRequest } from "@studio/episode";
import { levelRoot, resolveInside, type Level } from "./workspace-files.js";

export interface MusicRoutesOptions {
  root: string;
  level: Level;
  /** Route prefix, e.g. "/api/channels/:channel/series/:series". */
  prefix: string;
}

const STATUS_OF: Record<string, number> = {
  "bad-request": 400, "no-such-piece": 404, "bad-code": 422, "no-browser": 503, "render-failed": 500,
};

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof MusicError) {
    return reply.status(STATUS_OF[error.code] ?? 500).send({ error: error.code, message: error.message, problems: error.problems });
  }
  throw error;
}

/** Workspaces with a render in progress, by directory. */
const rendering = new Set<string>();

export function registerMusicRoutes(app: FastifyInstance, options: MusicRoutesOptions): void {
  const { root, level, prefix } = options;

  /** The workspace the request names, or null with the reply sent. */
  const workspaceOf = (request: FastifyRequest, reply: FastifyReply, within: unknown): string | null => {
    const levelDir = levelRoot(root, level, request.params as { channel: string; series?: string; episode?: string });
    const dir = typeof within === "string" && within !== "" ? resolveInside(levelDir, within) : levelDir;
    if (!dir) {
      void reply.status(403).send({ error: "forbidden", message: "within leads out of the workspace" });
      return null;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      void reply.status(404).send({ error: "no-workspace", message: `there is no such ${level}${within ? ` directory ${String(within)}` : ""}` });
      return null;
    }
    return dir;
  };

  app.get(`${prefix}/music`, {
    schema: { description: `The pieces of music (music/*.strudel) at the ${level} level and what was rendered from each; whether this machine can render.`, tags: ["music"] } as any,
  }, async (request, reply) => {
    const { within } = request.query as { within?: string };
    const dir = workspaceOf(request, reply, within);
    if (!dir) return reply;
    return { within: within ?? "", readiness: musicReadiness(), ...listMusic(dir) };
  });

  app.post(`${prefix}/music/check`, {
    schema: { description: "Evaluate a piece without a sound: { path | code, from?, cycles?, events?, only?, mute?, within? }. Its parts, events, sounds and problems.", tags: ["music"] } as any,
  }, async (request, reply) => {
    const { within, ...check } = (request.body ?? {}) as MusicCheckRequest & { within?: string };
    const dir = workspaceOf(request, reply, within);
    if (!dir) return reply;
    try {
      return await checkMusic(dir, check);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(`${prefix}/music/render`, {
    schema: {
      description: "Render a piece to a WAV in the workspace: { path, output?, from?, cycles | seconds, lead?, tail?, loop?, only?, mute?, stems?, seed?, level?, within? }. Answers when the file and its record are written.",
      tags: ["music"],
    } as any,
  }, async (request, reply) => {
    const { within, ...render } = (request.body ?? {}) as MusicRequest & { within?: string };
    const dir = workspaceOf(request, reply, within);
    if (!dir) return reply;
    if (rendering.has(dir)) {
      return reply.status(409).send({ error: "render-in-progress", message: "a piece of this workspace is being rendered: wait for it" });
    }
    rendering.add(dir);
    try {
      return await renderMusic(dir, render);
    } catch (error) {
      return sendError(reply, error);
    } finally {
      rendering.delete(dir);
    }
  });
}
