// ---------------------------------------------------------------------------
// Film routes (ADR-0050)
// ---------------------------------------------------------------------------
// A film's units are reached by every route an episode is — files, journal,
// stages, budget, reviews — as /api/channels/<film>/series/<scene>/episodes/
// <shot>, with `_` for the level itself. What is here is what only a film
// has: the film as a tree in running order, its footage, and its cuts — read,
// written by a person, assembled, shown at a frame and rendered.
//
// The work itself is @studio/film's, the same code the agent's tools and the
// render stage call. The gateway carries the request there (ADR-0027); it
// keeps the renders it started so that a second request does not start the
// same one twice, and so that a person can stop one.
// ---------------------------------------------------------------------------

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { libraryUrlPath } from "@studio/contracts/src/library-url.mjs";
import { FILM_FORMATS } from "@studio/contracts/src/film.mjs";
import type { CutTimeline } from "@studio/contracts/src/cut-timeline.mjs";
import {
  FilmError, assembleCut, checkUnitCut, createFilm, createScene, createShot, cutStatus, editCut, filmTree, levelOf, listEffects, listFilms,
  nextSteps, readCut, readFootage, readManifest, renderUnit, renderUnitFrame, setOrder, unitKey, unitLabel, unitOf, updateManifest, writeCut,
  annotateFootage, ingestFootage, filmUnit,
  type CutOp, type FilmTree, type SceneNode, type ShotNode, type UnitNode, type UnitRef, type UnitRender,
} from "@studio/film";
import { EventBus, createEvent } from "../events/bus.js";

interface FilmRouteOptions {
  root: string;
  bus?: EventBus;
}

interface UnitParams {
  film: string;
  scene: string;
  shot: string;
}

const UNIT = "/api/films/:film/units/:scene/:shot";

const STATUS_OF: Record<string, number> = {
  "bad-slug": 400, "bad-input": 400, "bad-unit": 400, "bad-format": 400, "bad-edit": 400, "bad-manifest": 422, "invalid-cut": 422,
  "no-unit": 404, "not-a-film": 404, "no-footage": 404, "missing-file": 404, "no-cut": 409, "revision-conflict": 409, "cut-exists": 409,
  "name-taken": 409, locked: 409, blocked: 409, "no-media": 409, "no-units": 409, cancelled: 499,
};

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof FilmError) {
    return reply.status(STATUS_OF[error.code] ?? 500).send({ error: error.code, message: error.message, problems: error.problems });
  }
  const e = error as { code?: string; message?: string; problems?: unknown[] };
  if (typeof e?.code === "string" && Array.isArray(e.problems)) {
    return reply.status(422).send({ error: e.code, message: e.message, problems: e.problems });
  }
  throw error;
}

/** What the browser needs beside a node of the tree: where to fetch its files and its render. */
function withUrls<T extends UnitNode<unknown>>(node: T): T & { url: string | null; renderUrl: string | null } {
  const ref = { kind: "film" as const, ...node.ref };
  const render = node.render ? node.render.path.split("/output/").pop() : null;
  return { ...node, url: libraryUrlPath(ref), renderUrl: render ? libraryUrlPath(ref, `output/${render}`) : null };
}

function treeForBrowser(tree: FilmTree) {
  return {
    ...withUrls(tree),
    scenes: tree.scenes.map((scene: SceneNode) => ({ ...withUrls(scene), shots: scene.shots.map((shot: ShotNode) => withUrls(shot)) })),
    next: nextSteps(tree),
  };
}

/** One render the gateway started and has not seen finish. */
interface RunningRender {
  key: string;
  quality: "final" | "preview";
  startedAt: string;
  controller: AbortController;
  progress: { unit: string; phase: string; done: number; total: number } | null;
}

export function registerFilmRoutes(app: FastifyInstance, options: FilmRouteOptions): void {
  const { root, bus } = options;
  /* eslint-disable @typescript-eslint/no-explicit-any */

  const unitFrom = (request: FastifyRequest): UnitRef => {
    const { film, scene, shot } = request.params as UnitParams;
    return unitOf(film, scene, shot);
  };

  /** Renders in progress, by film: a film's renders share its units, so one runs at a time. */
  const running = new Map<string, RunningRender>();
  const publish = (type: string, ref: UnitRef, data: Record<string, unknown>) =>
    bus?.publish(createEvent("pipeline", type, { unit: unitKey(ref), ...data }, unitKey(ref)));

  // ── The films, and what a film can be ──────────────────────────────────

  app.get("/api/films", { schema: { description: "The library's films.", tags: ["films"] } as any }, async () => {
    return listFilms(root).map((slug) => {
      const { manifest } = readManifest<{ title?: string; logline?: string; format?: unknown }>(root, filmUnit(slug));
      return { slug, title: manifest?.title ?? slug, logline: manifest?.logline ?? null, format: manifest?.format ?? null };
    });
  });

  app.get("/api/film-formats", { schema: { description: "The delivery formats a film can choose.", tags: ["films"] } as any }, async () => FILM_FORMATS);

  app.get("/api/cut-effects", { schema: { description: "The picture and sound effects a cut can use, with their parameters.", tags: ["films"] } as any }, async () => listEffects());

  app.post("/api/films", { schema: { description: "Create a film. Never overwrites.", tags: ["films"] } as any }, async (request, reply) => {
    try {
      return reply.status(201).send(createFilm(root, request.body as Parameters<typeof createFilm>[1]));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/films/:film/scenes", { schema: { description: "Create a scene of a film.", tags: ["films"] } as any }, async (request, reply) => {
    try {
      const { film } = request.params as { film: string };
      return reply.status(201).send(createScene(root, { ...(request.body as Omit<Parameters<typeof createScene>[1], "film">), film }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/films/:film/scenes/:scene/shots", { schema: { description: "Create a shot of a scene.", tags: ["films"] } as any }, async (request, reply) => {
    try {
      const { film, scene } = request.params as { film: string; scene: string };
      return reply.status(201).send(createShot(root, { ...(request.body as Omit<Parameters<typeof createShot>[1], "film" | "scene">), film, scene }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ── The film at a glance ───────────────────────────────────────────────

  app.get("/api/films/:film/tree", {
    schema: { description: "The film in running order: every scene and shot with its manifest, its cut and where its renders stand.", tags: ["films"] } as any,
  }, async (request, reply) => {
    try {
      const { film } = request.params as { film: string };
      const tree = treeForBrowser(filmTree(root, film));
      const render = running.get(film);
      return { ...tree, rendering: render ? { unit: render.key, quality: render.quality, startedAt: render.startedAt, progress: render.progress } : null };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ── Footage ────────────────────────────────────────────────────────────

  app.get("/api/films/:film/footage", { schema: { description: "The film's footage log.", tags: ["films"] } as any }, async (request, reply) => {
    try {
      const { film } = request.params as { film: string };
      const ref = { kind: "film" as const, channel: film };
      return readFootage(root, film).map((clip) => ({
        ...clip,
        url: libraryUrlPath(ref, clip.path),
        proxyUrl: clip.proxy ? libraryUrlPath(ref, clip.proxy) : null,
        sheetUrl: clip.sheet ? libraryUrlPath(ref, clip.sheet) : null,
      }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/films/:film/footage", {
    schema: { description: "Bring files on this machine into the film's footage: { files: [full paths], origin?, link?, tags?, notes?, licence?, scene?, shot? }.", tags: ["films"] } as any,
  }, async (request, reply) => {
    try {
      const { film } = request.params as { film: string };
      const { files, ...rest } = (request.body ?? {}) as { files?: unknown } & Record<string, unknown>;
      if (!Array.isArray(files) || files.length === 0 || !files.every((file) => typeof file === "string")) {
        return reply.status(400).send({ error: "bad-input", message: "files must be a list of full paths" });
      }
      const results = [];
      for (const file of files as string[]) results.push(await ingestFootage(root, film, file, rest as Parameters<typeof ingestFootage>[3]));
      return reply.status(201).send({ results });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch("/api/films/:film/footage/:clip", { schema: { description: "Change what the log says about a clip: tags, notes, licence, origin, scene, shot.", tags: ["films"] } as any }, async (request, reply) => {
    try {
      const { film, clip } = request.params as { film: string; clip: string };
      return annotateFootage(root, film, clip, (request.body ?? {}) as Parameters<typeof annotateFootage>[3]);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ── A unit's manifest ──────────────────────────────────────────────────

  app.get(`${UNIT}/manifest`, { schema: { description: "A unit's manifest as it is on disk, with what is wrong with it.", tags: ["films"] } as any }, async (request, reply) => {
    try {
      const ref = unitFrom(request);
      const { manifest, problems } = readManifest(root, ref);
      return { unit: ref, level: levelOf(ref), manifest, problems };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put(`${UNIT}/manifest`, {
    schema: { description: "Change a unit's manifest: { set: { field: value | null }, order?: [slugs] }. Written only when the result holds.", tags: ["films"] } as any,
  }, async (request, reply) => {
    try {
      const ref = unitFrom(request);
      const body = (request.body ?? {}) as { set?: Record<string, unknown>; order?: string[] };
      if (body.set && Object.keys(body.set).length > 0) {
        for (const key of ["slug", "kind", "apiVersion"]) {
          if (key in body.set) return reply.status(400).send({ error: "bad-input", message: `"${key}" is what the unit is: it is not changed` });
        }
        updateManifest(root, ref, (manifest) => {
          const next = { ...manifest } as Record<string, unknown>;
          for (const [key, value] of Object.entries(body.set!)) {
            if (value === null) delete next[key];
            else next[key] = value;
          }
          return next as unknown as typeof manifest;
        });
      }
      if (Array.isArray(body.order)) setOrder(root, ref, body.order);
      publish("unit.manifest-changed", ref, {});
      const { manifest, problems } = readManifest(root, ref);
      return { unit: ref, level: levelOf(ref), manifest, problems };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ── A unit's cut ───────────────────────────────────────────────────────

  const cutView = (ref: UnitRef) => {
    const stored = readCut(root, ref);
    return { unit: ref, level: levelOf(ref), cut: stored.cut, exists: stored.exists, hash: stored.hash, status: cutStatus(root, ref) };
  };

  app.get(`${UNIT}/cut`, { schema: { description: "A unit's cut, with its problems and where its renders stand.", tags: ["films"] } as any }, async (request, reply) => {
    try {
      return cutView(unitFrom(request));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(`${UNIT}/cut/check`, { schema: { description: "What a render of the unit's cut would refuse or warn about: files and effects included.", tags: ["films"] } as any }, async (request, reply) => {
    try {
      const quality = (request.query as { quality?: string }).quality === "preview" ? "preview" : "final";
      return { problems: await checkUnitCut(root, unitFrom(request), quality) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put(`${UNIT}/cut`, {
    schema: { description: "Write a person's edit of the cut: { cut, expectedRevision } or { ops, expectedRevision }. Refused when the cut moved on since it was read.", tags: ["films"] } as any,
  }, async (request, reply) => {
    try {
      const ref = unitFrom(request);
      const body = (request.body ?? {}) as { cut?: CutTimeline; ops?: CutOp[]; expectedRevision?: number };
      if (typeof body.expectedRevision !== "number") {
        return reply.status(400).send({ error: "bad-input", message: "expectedRevision is required: the revision the edit was made on" });
      }
      if (Array.isArray(body.ops)) editCut(root, ref, body.ops, { editor: "person", expectedRevision: body.expectedRevision });
      else if (body.cut) writeCut(root, ref, body.cut, { expectedRevision: body.expectedRevision });
      else return reply.status(400).send({ error: "bad-input", message: "give cut or ops" });
      publish("cut.changed", ref, { by: "person" });
      return cutView(ref);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(`${UNIT}/cut/assemble`, {
    schema: { description: "Make the unit's cut, or bring it in step with what is under it: a shot from its media, a scene from its shots, the film from its scenes.", tags: ["films"] } as any,
  }, async (request, reply) => {
    try {
      const ref = unitFrom(request);
      const result = await assembleCut(root, ref, (request.body ?? {}) as Parameters<typeof assembleCut>[2]);
      publish("cut.changed", ref, { by: "assemble" });
      return { ...cutView(ref), notes: result.notes };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(`${UNIT}/cut/frame`, {
    schema: { description: "One frame of the cut as an image, with every effect: { frame, width? }. What the timeline shows at an instant.", tags: ["films"] } as any,
  }, async (request, reply) => {
    try {
      const ref = unitFrom(request);
      const body = (request.body ?? {}) as { frame?: number; width?: number };
      const frame = await renderUnitFrame(root, ref, Number(body.frame ?? 0), { width: Math.min(1280, Math.max(160, Number(body.width ?? 960))) });
      // Relative to the library: the static mount serves it.
      return { ...frame, url: `/library/${frame.path.split("/").map(encodeURIComponent).join("/")}` };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // ── Rendering ──────────────────────────────────────────────────────────

  app.post(`${UNIT}/cut/render`, {
    schema: {
      description: "Start a render of the unit's cut: { quality: final|preview, from?, to? (frames), cascade?, force? }. Answers at once; progress and the result arrive as events, and the tree shows the render in progress.",
      tags: ["films"],
    } as any,
  }, async (request, reply) => {
    let ref: UnitRef;
    try {
      ref = unitFrom(request);
    } catch (error) {
      return sendError(reply, error);
    }
    const body = (request.body ?? {}) as { quality?: string; from?: number; to?: number; cascade?: boolean; force?: boolean };
    const quality = body.quality === "preview" ? "preview" : "final";
    const current = running.get(ref.channel);
    if (current) {
      return reply.status(409).send({ error: "render-in-progress", message: `${current.key} is being rendered (${current.quality}): wait for it, or stop it`, rendering: current.key });
    }
    const status = cutStatus(root, ref);
    if (status.state === "no-cut" || status.state === "invalid-cut") {
      return reply.status(409).send({ error: status.state, message: status.reason, problems: status.problems });
    }
    const job: RunningRender = { key: unitKey(ref), quality, startedAt: new Date().toISOString(), controller: new AbortController(), progress: null };
    running.set(ref.channel, job);
    publish("render.started", ref, { quality });
    const range = body.from !== undefined || body.to !== undefined
      ? { from: Math.max(0, Math.round(body.from ?? 0)), to: Math.round(body.to ?? Number.MAX_SAFE_INTEGER) }
      : undefined;
    let lastPublished = 0;
    void renderUnit(root, ref, {
      quality,
      actor: request.principal === "operator" ? "human" : "gateway",
      signal: job.controller.signal,
      ...(range ? { range } : {}),
      ...(body.cascade === false ? { cascade: false } : {}),
      ...(body.force ? { force: true } : {}),
      onProgress: (progress) => {
        job.progress = { unit: progress.unit, phase: progress.phase, done: progress.done, total: progress.total };
        // At most four a second: a film has hundreds of windows, and each subscriber redraws on every event.
        const now = Date.now();
        if (now - lastPublished > 250 || progress.done === progress.total) {
          lastPublished = now;
          publish("render.progress", ref, { ...job.progress, quality });
        }
      },
    }).then((render: UnitRender) => {
      const flatten = (r: UnitRender): { unit: string; renderId: string; reused: boolean }[] =>
        [...r.cascaded.flatMap(flatten), { unit: unitKey(r.unit), renderId: r.renderId, reused: r.reused }];
      publish("render.completed", ref, {
        quality, renderId: render.renderId, path: render.path, current: render.current, reused: render.reused,
        frames: render.frames, durationSeconds: render.durationSeconds, units: flatten(render),
        warnings: render.warnings.map((warning) => warning.message),
        url: `/library/${render.path.split("/").map(encodeURIComponent).join("/")}`,
      });
    }).catch((error: unknown) => {
      const e = error as { code?: string; message?: string; problems?: unknown[] };
      request.log.warn(`render of ${unitLabel(ref)} failed: ${e.message ?? String(error)}`);
      publish("render.failed", ref, { quality, code: e.code ?? "render-failed", message: e.message ?? String(error), problems: e.problems ?? [] });
    }).finally(() => {
      if (running.get(ref.channel) === job) running.delete(ref.channel);
    });
    return reply.status(202).send({ rendering: job.key, quality, startedAt: job.startedAt });
  });

  app.delete("/api/films/:film/render", { schema: { description: "Stop the film's render in progress.", tags: ["films"] } as any }, async (request, reply) => {
    const { film } = request.params as { film: string };
    const job = running.get(film);
    if (!job) return reply.status(404).send({ error: "no-render", message: "nothing of this film is being rendered" });
    job.controller.abort();
    return { stopping: job.key };
  });
}

