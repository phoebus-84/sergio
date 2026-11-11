// A film made through the agent's tools: created, cut from generated colour,
// rendered, changed. And the studio's other tools reaching a film's units.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFilmTools } from "../src/film-tools.js";
import { sanitizeSlug } from "../src/trust-guards.js";
import { workspaceOf } from "../src/workspace-target.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

let root: string;
const previous = process.env.AVG_LIBRARY_ROOT;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "film-tools-"));
  process.env.AVG_LIBRARY_ROOT = root;
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.AVG_LIBRARY_ROOT;
  else process.env.AVG_LIBRARY_ROOT = previous;
});

function tools() {
  const registered = new Map<string, any>();
  registerFilmTools({ registerTool: (t: { name: string }) => registered.set(t.name, t) } as never);
  return Object.assign(
    async (name: string, params: Record<string, unknown>) => {
      const result = await registered.get(name)!.execute("call", params);
      return { ...result, text: result.content[0].text as string };
    },
    { names: () => [...registered.keys()].sort() },
  );
}

describe("film tools", () => {
  const run = tools();

  it("registers the film's tools, each saying what it does", () => {
    expect(run.names()).toEqual([
      "pva_assemble_cut", "pva_check_cut", "pva_create_film", "pva_create_scene", "pva_create_shot", "pva_cut_effects", "pva_cut_frame",
      "pva_edit_cut", "pva_film", "pva_footage", "pva_ingest_footage", "pva_inspect_media", "pva_render_cut", "pva_update_unit",
    ]);
  });

  it("makes a film, its scenes and shots, and gives each unit's address for the other tools", async () => {
    expect((await run("pva_film", {})).text).toMatch(/no film yet/);
    const film = await run("pva_create_film", { slug: "tide", title: "Tide", logline: "A keeper counts the waves.", format: "hd-24" });
    expect(film.isError).toBeUndefined();
    expect(film.text).toContain("channel: tide, series: _, episode: _");
    const scene = await run("pva_create_scene", { film: "tide", slug: "010-shore", title: "The shore", heading: "EXT. SHORE - DUSK", sequence: "night", sequenceTitle: "Night" });
    expect(scene.text).toContain("channel: tide, series: 010-shore, episode: _");
    const shot = await run("pva_create_shot", { film: "tide", scene: "010-shore", slug: "010-sky", title: "The sky", source: "generated", size: "wide", durationSeconds: 1 });
    expect(shot.text).toContain("channel: tide, series: 010-shore, episode: 010-sky");
    await run("pva_create_shot", { film: "tide", scene: "010-shore", slug: "020-sea", title: "The sea", source: "stock", durationSeconds: 0.5 });
    expect((await run("pva_film", {})).text).toBe("Films: tide");
    expect((await run("pva_create_film", { slug: "tide", title: "Again" })).text).toMatch(/already there/);
    expect((await run("pva_create_shot", { film: "tide", scene: "nowhere", slug: "a", title: "A", source: "stock" })).isError).toBe(true);
  });

  it("lets the studio's other tools name a film's units", () => {
    expect(workspaceOf(root, { channel: "tide", series: "010-shore", episode: "010-sky" })).toMatchObject({ kind: "episode", dir: join(root, "tide/scenes/010-shore/shots/010-sky") });
    expect(workspaceOf(root, { channel: "tide", series: "010-shore", episode: "_" })).toMatchObject({ dir: join(root, "tide/scenes/010-shore") });
    expect(workspaceOf(root, { channel: "tide", series: "_", episode: "_" })).toMatchObject({ dir: join(root, "tide") });
    expect(() => workspaceOf(root, { channel: "_", series: "_", episode: "_" })).toThrow(/not a slug/);
    expect(sanitizeSlug("tide/010-shore/_").allowed).toBe(true);
    expect(sanitizeSlug("tide/_/_").allowed).toBe(true);
    expect(sanitizeSlug("_/a/b").allowed).toBe(false);
    expect(sanitizeSlug("tide/../x").allowed).toBe(false);
  });

  it("changes a manifest and an order, refusing what does not hold", async () => {
    const set = await run("pva_update_unit", { film: "tide", scene: "010-shore", set: { timeOfDay: "dusk", heading: null }, order: ["020-sea", "010-sky"] });
    expect(set.text).toBe("✅ tide/010-shore: set timeOfDay, heading; order: 020-sea → 010-sky");
    const yaml = readFileSync(join(root, "tide/scenes/010-shore/scene.yaml"), "utf-8");
    expect(yaml).toContain("timeOfDay: dusk");
    expect(yaml).not.toContain("heading");
    expect((await run("pva_update_unit", { film: "tide", set: { slug: "other" } })).text).toMatch(/is what the unit is/);
    expect((await run("pva_update_unit", { film: "tide", scene: "010-shore", shot: "010-sky", set: { size: "enormous" } })).isError).toBe(true);
    await run("pva_update_unit", { film: "tide", scene: "010-shore", order: ["010-sky", "020-sea"] });
  });

  it("lists the effects a cut can use", async () => {
    const all = await run("pva_cut_effects", {});
    expect(all.text).toMatch(/^Picture · Light\n {2}exposure — Brighter or darker, in stops\. stops -3…3 EV \(default 0\)/);
    expect(all.text).toContain("Sound · Dynamics");
    expect((await run("pva_cut_effects", { domain: "audio" })).text).not.toContain("Picture");
  });

  it("edits a cut by operations, as the agent: a person's lock holds", async () => {
    const edited = await run("pva_edit_cut", { film: "tide", scene: "010-shore", shot: "010-sky", ops: [
      { op: "add-clip", track: "v1", clip: { id: "sky", source: { color: "#203050" }, duration: 24, effects: [{ type: "vignette" }] } },
    ] });
    expect(edited.isError).toBeUndefined();
    expect(edited.text).toContain("00:00:00:00 +24f  sky ← #203050 [vignette]");
    await run("pva_edit_cut", { film: "tide", scene: "010-shore", shot: "020-sea", ops: [{ op: "add-clip", track: "v1", clip: { id: "sea", source: { color: "#104030" }, duration: 12 } }] });
    const bad = await run("pva_edit_cut", { film: "tide", scene: "010-shore", shot: "010-sky", ops: [{ op: "set-clip", clip: "sky", set: { effects: [{ type: "sparkle" }] } }, { op: "remove-clip", clip: "nobody" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/operation 2 \(remove-clip\)/);
    expect((await run("pva_edit_cut", { film: "tide", scene: "010-shore", shot: "010-sky", ops: [{ op: "set-clip", clip: "sky", set: { locked: true } }] })).text).toMatch(/only a person locks/);
    expect((await run("pva_edit_cut", { film: "tide", scene: "010-shore", shot: "010-sky", expectedRevision: 7, ops: [{ op: "set-clip", clip: "sky", set: { opacity: 1 } }] })).text).toMatch(/revision-conflict/);
  });

  it.skipIf(!hasFfmpeg)("assembles, checks, renders the film through its levels, and renders only what changed", async () => {
    expect((await run("pva_assemble_cut", { film: "tide", scene: "010-shore", transition: { type: "dissolve", duration: 6 } })).text).toMatch(/cut revision 1, 1\.3s \(30 frames\)/);
    expect((await run("pva_assemble_cut", { film: "tide" })).text).toContain("010-shore: added, 30 frames (its cut)");
    const before = await run("pva_film", { film: "tide" });
    expect(before.text).toContain("⏸ tide — Tide");
    expect(before.text).toContain("▸ Night");
    expect(before.text).toContain("      ○ 010-sky — The sky · 1s · not-rendered: the cut is ready to render");
    expect(before.text).toContain("Next, in order:\n  tide/010-shore/010-sky — the cut is ready to render");
    const checked = await run("pva_check_cut", { film: "tide", scene: "010-shore" });
    expect(checked.isError).toBe(true);
    expect(checked.text).toContain("✗ unit-not-rendered");

    const updates: string[] = [];
    const registered = new Map<string, any>();
    registerFilmTools({ registerTool: (t: { name: string }) => registered.set(t.name, t) } as never);
    const rendered = await registered.get("pva_render_cut")!.execute("call", { film: "tide" }, undefined, (u: { content: { text: string }[] }) => updates.push(u.content[0]!.text));
    expect(rendered.isError).toBeUndefined();
    const text = rendered.content[0].text as string;
    expect(text.split("\n").map((line: string) => line.trim().split(" → ")[0])).toEqual([
      "✅ rendered tide/010-shore/010-sky", "✅ rendered tide/010-shore/020-sea", "✅ rendered tide/010-shore", "✅ rendered tide",
    ]);
    expect(updates.some((line) => line.startsWith("tide/010-shore/010-sky: picture"))).toBe(true);
    const path = rendered.details.render.path as string;
    expect(Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", join(root, path)]).toString().trim())).toBe(30);

    const after = await run("pva_film", { film: "tide" });
    expect(after.text).toContain("● tide — Tide · 1.3s · current");
    expect(after.text).toContain(`The film is rendered: ${path}`);

    await run("pva_edit_cut", { film: "tide", scene: "010-shore", shot: "020-sea", ops: [{ op: "set-clip", clip: "sea", set: { effects: [{ type: "monochrome" }] } }] });
    expect((await run("pva_film", { film: "tide", scene: "010-shore" })).text).toContain("↻ 020-sea");
    const again = await run("pva_render_cut", { film: "tide" });
    expect(again.text.split("\n").map((line: string) => line.trim().split(" → ")[0])).toEqual(["✅ rendered tide/010-shore/020-sea", "✅ rendered tide/010-shore", "✅ rendered tide"]);
    expect((await run("pva_render_cut", { film: "tide" })).text).toMatch(/^● kept tide →/);

    const part = await run("pva_render_cut", { film: "tide", quality: "preview", from: 0, to: 0.5 });
    expect(part.text).toContain("A part of the cut");
    const frame = await run("pva_cut_frame", { film: "tide", scene: "010-shore", seconds: 0.5, width: 320 });
    expect(frame.text).toMatch(/frame 12 \(00:00:00:12\) of tide\/010-shore → tide\/scenes\/010-shore\/artifacts\/frames\/frame-000012-r1\.jpg/);
    expect(existsSync(join(root, frame.details.path as string))).toBe(true);
  }, 240_000);

  it.skipIf(!hasFfmpeg)("brings footage in, finds it, and reads a file of a shot", async () => {
    const camera = mkdtempSync(join(tmpdir(), "film-tools-camera-"));
    try {
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(camera, "B002.mp4")]);
      const brought = await run("pva_ingest_footage", { film: "tide", files: [join(camera, "B002.mp4")], tags: ["sea"], scene: "010-shore" });
      expect(brought.text).toMatch(/^✅ b002-[a-f0-9]{8} — 320×180 at 24 fps, 2s, silent\n {3}project: footage\/media\/b002-[a-f0-9]{8}\.mp4\n {3}sheet: tide\/footage\/sheets\//);
      expect((await run("pva_ingest_footage", { film: "tide", files: [join(camera, "B002.mp4")] })).text).toMatch(/^● b002-/);
      const id = brought.details.clips[0].id as string;
      expect((await run("pva_footage", { film: "tide", annotate: { id, notes: "the good one" } })).text).toBe(`✅ ${id}: notes updated`);
      expect((await run("pva_footage", { film: "tide", query: "good sea" })).text).toContain(`${id} — video, 2s, camera, for 010-shore [sea] — the good one`);
      expect((await run("pva_footage", { film: "tide", query: "nothing-like-it" })).text).toBe("No footage matches.");
      const cut = await run("pva_assemble_cut", { film: "tide", scene: "010-shore", shot: "020-sea", media: `project:footage/media/${id}.mp4`, in: 0.5, seconds: 1, replace: true });
      expect(cut.text).toContain(`cut from the film's footage/media/${id}.mp4: 1.00 s from 0.5 s`);
      const seen = await run("pva_inspect_media", { film: "tide", scene: "010-shore", shot: "020-sea", path: `project:footage/media/${id}.mp4`, segments: true });
      expect(seen.text).toMatch(/video, 320×180 at 24 fps, 2\.00 s, h264, no sound\nsheet: tide\/scenes\/010-shore\/shots\/020-sea\/artifacts\/inspect\//);
    } finally {
      rmSync(camera, { recursive: true, force: true });
    }
  }, 120_000);
});
