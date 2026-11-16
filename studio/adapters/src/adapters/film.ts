// ---------------------------------------------------------------------------
// The film stages the studio performs (ADR-0050)
// ---------------------------------------------------------------------------
// Rendering a unit's cut — a shot's, a scene's, the film's — is the same code
// the agent's tool calls (@studio/film), so a stage and a tool never disagree.
// What the cut says is editorial and stays with the agent or a person; this
// only renders it.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CUT_RENDER_PATH } from "@studio/contracts/src/cut-timeline.mjs";
import { projectKind } from "@studio/contracts/src/layout.mjs";
import { libraryRootOf, renderUnit, unitLabel } from "@studio/film";
import type { StageAdapter } from "../descriptor.js";

export const cutRender: StageAdapter = {
  id: "cut-render",
  summary: "Renders a film unit's cut with FFmpeg to output/<render-id>.mp4, rendering first the units under it that changed, and records the render",
  capability: "video.compose",
  provider: "video-composer",
  produces: ["cut-render.json"],
  consumes: ["cut.json"],
  requires: { system: ["ffmpeg", "ffprobe"] },
  async perform(ctx) {
    const root = libraryRootOf(ctx.episodeDir, ctx.ref);
    if (projectKind(root, ctx.ref.channel) !== "film") {
      throw new Error("this stage renders a film's cut, and this unit is not in a film");
    }
    let phase = "";
    let render;
    try {
      render = await renderUnit(root, ctx.ref, {
        quality: "final",
        actor: "runtime",
        onProgress: (p) => {
          const label = `${p.unit}: ${p.phase}`;
          if (label !== phase && p.done === 0) {
            phase = label;
            ctx.log(`  ${label}${p.total > 1 ? ` (${p.total})` : ""}`);
          }
        },
      });
    } catch (error) {
      const problems = (error as { problems?: { code: string; message: string; path?: string }[] }).problems ?? [];
      for (const p of problems.slice(0, 20)) ctx.log(`    ${p.code}${p.path ? ` at ${p.path}` : ""}: ${p.message}`);
      throw error;
    }
    const count = (r: typeof render): number => r.cascaded.reduce((sum, child) => sum + count(child), r.reused ? 0 : 1);
    ctx.log(`  ${unitLabel(ctx.ref)}: ${render.reused ? "already rendered" : "rendered"} ${render.renderId}, ${render.frames} frames` +
      `${count(render) > (render.reused ? 0 : 1) ? ` (${count(render)} units rendered in all)` : ""}`);
    for (const warning of render.warnings) ctx.log(`    ⚠️ ${warning.message}`);
    const record = join(ctx.episodeDir, CUT_RENDER_PATH);
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, `${JSON.stringify({
      apiVersion: "studio.video/v1alpha1",
      kind: "CutRenderRecord",
      unit: ctx.ref,
      renderId: render.renderId,
      quality: render.quality,
      path: render.path,
      report: render.reportPath,
      frames: render.frames,
      durationSeconds: render.durationSeconds,
      rendered: render.cascaded.map((child) => ({ unit: child.unit, renderId: child.renderId, reused: child.reused })),
    }, null, 2)}\n`);
    return [record];
  },
};
