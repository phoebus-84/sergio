// ---------------------------------------------------------------------------
// Style routes (ADR-0054)
// ---------------------------------------------------------------------------
// The templates there are, and a level's style: applied, read, its parameters
// changed by a person in the studio (a colour picker writes params/palette.json)
// and kept as a template of its own. The work is @studio/style's, the same
// code the agent's tools call (ADR-0027).
//
// What only the gateway does is the renewal: a change made here is accepted
// for every unit that read the style, through the runtime, which journals the
// stages that must be redone. A change made by hand on disk shows as stale
// until `/renew` (or `vpr pin renew`) accepts it.
// ---------------------------------------------------------------------------

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { STYLE_PIN_ID, type StyleParams } from "@studio/contracts/src/style.mjs";
import { defaultPipeline, pipelineOf } from "@studio/runtime";
import {
  StyleError, applyStyle, dependentsOf, findStyle, inheritedTarget, listStyles, readStyleFolder, readTargetStyle, saveStyleAsTemplate,
  targetLabel, targetLevel, unitLabel, writeStyleBrief, writeStyleParams,
  type StyleTarget, type TargetStyle, type UnitRef,
} from "@studio/style";
import { makeExecutionService } from "../runtime/service.js";
import { EventBus, createEvent } from "../events/bus.js";

/** Accept a style change for one unit: the stages it makes stale, or why it could not. */
export type RenewStyle = (unit: UnitRef, actor: "human" | "pi") => Promise<{ affected: string[] } | { message: string }>;

interface StyleRouteOptions {
  root: string;
  operatorKey?: string | null;
  bus?: EventBus;
  /** Replaced in tests; by default the runtime renews the unit's `style` pin. */
  renew?: RenewStyle;
}

const STATUS_OF: Record<string, number> = {
  "bad-slug": 400, "bad-input": 400, "bad-params": 422, "bad-brief": 422, "bad-style": 422, "wrong-level": 422,
  "no-target": 404, "no-style": 404, "no-style-here": 404, "no-parent-style": 404, "unknown-param": 404,
  "ambiguous-style": 409, "style-exists": 409, "template-exists": 409,
};

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof StyleError) {
    return reply.status(STATUS_OF[error.code] ?? 500).send({ error: error.code, message: error.message, problems: error.problems });
  }
  throw error;
}

const targetFrom = (request: FastifyRequest): StyleTarget => {
  const { project, series } = request.params as { project: string; series: string };
  return series && series !== "_" ? { project, series } : { project };
};

function defaultRenew(root: string, operatorKey: string | null): RenewStyle {
  return async (unit, actor) => {
    let pipeline: string;
    try {
      pipeline = pipelineOf(root, unit);
    } catch {
      pipeline = defaultPipeline(root, unit);
    }
    const service = makeExecutionService(() => undefined, root, operatorKey);
    const out = await service.renewPin(unit, pipeline, STYLE_PIN_ID, actor);
    if (!out.ok) return { message: `${out.error.code}: ${out.error.message}` };
    if (!out.value.ok) return { message: out.value.refusal.message };
    return { affected: out.value.affected };
  };
}

/** A level's style as the browser shows it. */
function styleView(root: string, style: TargetStyle | null) {
  if (!style) return null;
  return {
    target: style.target,
    level: style.level,
    binding: style.binding,
    template: style.folder.template,
    brief: style.folder.brief,
    params: style.folder.params,
    rendered: style.rendered,
    problems: style.problems,
    dependents: dependentsOf(root, style.target).map(unitLabel),
  };
}

export function registerStyleRoutes(app: FastifyInstance, options: StyleRouteOptions): void {
  const { root, bus } = options;
  const renew = options.renew ?? defaultRenew(root, options.operatorKey ?? null);
  /* eslint-disable @typescript-eslint/no-explicit-any */

  /** Accept a change for every unit that reads the target's style. */
  async function renewAll(target: StyleTarget, actor: "human" | "pi") {
    const renewed: { unit: string; affected: string[] }[] = [];
    const failed: { unit: string; message: string }[] = [];
    for (const unit of dependentsOf(root, target)) {
      const out = await renew(unit, actor);
      if ("affected" in out) renewed.push({ unit: unitLabel(unit), affected: out.affected });
      else failed.push({ unit: unitLabel(unit), message: out.message });
      bus?.publish(createEvent("pipeline", "style.renewed", { unit: unitLabel(unit), style: targetLabel(target) }, unitLabel(unit)));
    }
    return { renewed, failed };
  }

  const LEVEL = "/api/style/:project/:series";

  // ── The templates ─────────────────────────────────────────────────────

  app.get("/api/styles", {
    schema: { description: "The style templates a project can use: the studio's, the library's _styles/ and its own styles/, nearest winning.", tags: ["styles"] } as any,
  }, async (request) => {
    const { project } = request.query as { project?: string };
    return listStyles(root, { project: project || undefined });
  });

  app.get("/api/styles/:id", {
    schema: { description: "One template in full: its manifest, brief and parameter files.", tags: ["styles"] } as any,
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { project } = request.query as { project?: string };
      const found = findStyle(root, id, { project: project || undefined });
      const folder = readStyleFolder(found.path);
      return { ...found, template: folder.template, brief: folder.brief, params: folder.params };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/styles", {
    schema: { description: "Keep a level's style, as edited there, as a template of its own. Never overwrites.", tags: ["styles"] } as any,
  }, async (request, reply) => {
    try {
      const body = request.body as { project: string; series?: string; id: string; title?: string; summary?: string; scope?: "library" | "project" };
      const from = body.series && body.series !== "_" ? { project: body.project, series: body.series } : { project: body.project };
      return reply.status(201).send(saveStyleAsTemplate(root, from, body));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ── A level's style ───────────────────────────────────────────────────

  app.get(LEVEL, {
    schema: { description: "The style a channel, series, film or scene has (`_` for the project itself), and the one it inherits when it has none.", tags: ["styles"] } as any,
  }, async (request, reply) => {
    try {
      const target = targetFrom(request);
      const own = readTargetStyle(root, target);
      const inheritedFrom = own ? null : inheritedTarget(root, target);
      return {
        target,
        level: targetLevel(root, target),
        own: styleView(root, own),
        inherited: inheritedFrom ? styleView(root, readTargetStyle(root, inheritedFrom)) : null,
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(LEVEL, {
    schema: { description: "Apply a template (or the level above's style) to this level, and pin it for every unit under it.", tags: ["styles"] } as any,
  }, async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { style?: string; fromParent?: boolean; replace?: boolean; note?: string };
      const result = await applyStyle(root, targetFrom(request), body);
      return reply.status(201).send({ ...result, units: result.units.map((u) => ({ unit: unitLabel(u.unit), outcome: u.outcome })) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put(`${LEVEL}/params/:param`, {
    schema: { description: "Replace one parameter file of this level's style, checked, and accept the change for every unit that reads it.", tags: ["styles"] } as any,
  }, async (request, reply) => {
    try {
      const target = targetFrom(request);
      const { param } = request.params as { param: string };
      const body = request.body as { doc?: StyleParams };
      if (!body?.doc) throw new StyleError("send the parameter file as `doc`", "bad-input");
      const change = writeStyleParams(root, target, param, body.doc);
      return { path: change.path, ...(await renewAll(target, "human")) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put(`${LEVEL}/brief`, {
    schema: { description: "Replace this level's STYLE.md; every placeholder must name a value. Accepted for every unit that reads it.", tags: ["styles"] } as any,
  }, async (request, reply) => {
    try {
      const target = targetFrom(request);
      const body = request.body as { text?: string };
      if (typeof body?.text !== "string") throw new StyleError("send the brief as `text`", "bad-input");
      const change = writeStyleBrief(root, target, body.text);
      return { path: change.path, ...(await renewAll(target, "human")) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(`${LEVEL}/renew`, {
    schema: { description: "Accept this level's style as it is now for every unit that reads it: the stages that read it, and their downstream, must be redone.", tags: ["styles"] } as any,
  }, async (request, reply) => {
    try {
      const target = targetFrom(request);
      if (!readTargetStyle(root, target)) throw new StyleError(`${targetLabel(target)} has no style of its own`, "no-style-here");
      const body = (request.body ?? {}) as { actor?: string };
      return await renewAll(target, body.actor === "pi" ? "pi" : "human");
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
