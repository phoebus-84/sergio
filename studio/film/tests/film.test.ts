// A film from nothing to a render: made, shot (with generated picture and
// tone), assembled at three levels, rendered, changed and rendered again.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKind, episodePath, SELF } from "@studio/contracts/src/layout.mjs";
import {
  FilmError, annotateFootage, applyCutOps, assembleCut, checkUnitCut, createFilm, createScene, createShot, cutStatus, editCut,
  filmTree, filmUnit, ingestFootage, inspectMedia, listFilms, listScenes, listShots, nextSteps, readCut, readFootage,
  readManifest, readPointer, renderUnit, renderUnitFrame, sceneUnit, searchFootage, setOrder, shotUnit, unitOf, updateManifest, writeCut,
} from "../src/index.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

describe("making a film", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "film-make-"));
    mkdirSync(join(root, "lessons", "series"), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("makes a film, a scene and a shot, each a production unit", () => {
    const film = createFilm(root, { slug: "tide", title: "Tide", logline: "A lighthouse keeper counts the waves.", format: "scope-24" });
    expect(projectKind(root, "tide")).toBe("film");
    expect(film.createdFiles).toContain("tide/film.yaml");
    expect(listFilms(root)).toEqual(["tide"]);
    for (const folder of ["bible", "footage", "music", "scenes", "journal", "output", "artifacts"]) expect(existsSync(join(root, "tide", folder)), folder).toBe(true);
    expect(readManifest(root, filmUnit("tide")).problems).toEqual([]);

    createScene(root, { film: "tide", slug: "020-lamp", title: "The lamp", sequence: "night", act: "I" });
    createScene(root, { film: "tide", slug: "010-shore", title: "The shore", heading: "EXT. SHORE - DUSK", setting: "ext", sequence: "night" });
    createScene(root, { film: "tide", slug: "005-loose", title: "Loose" });
    expect(listScenes(root, "tide").scenes).toEqual([
      { scene: "020-lamp", sequence: "night", act: "I" },
      { scene: "010-shore", sequence: "night", act: "I" },
      { scene: "005-loose", sequence: null, act: null },
    ]);

    const shot = createShot(root, { film: "tide", scene: "010-shore", slug: "020-wave", title: "A wave", source: "footage", size: "wide", durationSeconds: 2 });
    createShot(root, { film: "tide", scene: "010-shore", slug: "010-sky", title: "The sky", source: "generated" });
    expect(shot.path).toBe(episodePath(root, "tide", "010-shore", "020-wave"));
    expect(listShots(root, "tide", "010-shore").order).toEqual(["010-sky", "020-wave"]);
    expect(existsSync(join(shot.path, "journal", "events.jsonl"))).toBe(true);
  });

  it("makes nothing twice and overwrites nothing", () => {
    writeFileSync(join(root, "tide", "README.md"), "mine\n");
    const again = createFilm(root, { slug: "tide", title: "Another title" });
    expect(again.createdFiles).toEqual([]);
    expect(readFileSync(join(root, "tide", "README.md"), "utf-8")).toBe("mine\n");
    expect(readManifest<{ title: string }>(root, filmUnit("tide")).manifest!.title).toBe("Tide");
  });

  it("refuses a channel's name, a bad slug, a shot without a scene", () => {
    expect(() => createFilm(root, { slug: "lessons", title: "Lessons" })).toThrow(/already a channel/);
    expect(() => createFilm(root, { slug: "My Film", title: "x" })).toThrow(FilmError);
    expect(() => createShot(root, { film: "tide", scene: "nowhere", slug: "a", title: "A", source: "stock" })).toThrow(/no scene/);
    expect(() => unitOf("tide", null, "a")).toThrow(/inside a scene/);
    expect(unitOf("tide", "010-shore")).toEqual({ channel: "tide", series: "010-shore", episode: SELF });
  });

  it("changes a manifest only into one that holds, keeping its comments", () => {
    const path = join(root, "tide", "scenes", "010-shore", "scene.yaml");
    writeFileSync(path, `# the opening\n${readFileSync(path, "utf-8")}`);
    updateManifest(root, sceneUnit("tide", "010-shore"), (scene) => ({ ...scene, timeOfDay: "dusk" }));
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("# the opening");
    expect(text).toContain("timeOfDay: dusk");
    expect(() => updateManifest(root, sceneUnit("tide", "010-shore"), (scene) => ({ ...scene, setting: "outside" as never }))).toThrow(/does not hold/);
    expect(readFileSync(path, "utf-8")).toBe(text);
  });

  it("reorders shots, and scenes inside their sequences", () => {
    setOrder(root, sceneUnit("tide", "010-shore"), ["020-wave", "010-sky"]);
    expect(listShots(root, "tide", "010-shore").order).toEqual(["020-wave", "010-sky"]);
    setOrder(root, filmUnit("tide"), ["010-shore", "020-lamp", "005-loose"]);
    expect(listScenes(root, "tide").scenes.map((s) => [s.scene, s.sequence])).toEqual([["010-shore", "night"], ["020-lamp", "night"], ["005-loose", "unsequenced"]]);
    expect(() => setOrder(root, sceneUnit("tide", "010-shore"), ["a", "a"])).toThrow(/twice/);
  });
});

describe("editing a cut", () => {
  let root: string;
  const scene = sceneUnit("tide", "010");
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "film-edit-"));
    createFilm(root, { slug: "tide", title: "Tide" });
    createScene(root, { film: "tide", slug: "010", title: "Shore" });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("applies operations together, counting revisions", () => {
    const first = editCut(root, scene, [
      { op: "add-clip", track: "v1", clip: { id: "a", source: { color: "#101010" }, duration: 48 } },
      { op: "add-clip", track: "v1", clip: { id: "b", source: { color: "#202020" }, duration: 48, transitionIn: { type: "dissolve", duration: 12 } } },
      { op: "add-track", track: { id: "music", kind: "audio", role: "music", gain: -6 } },
      { op: "set-track", track: "music", set: { duck: { under: ["a1"], gain: -9 } } },
      { op: "set-master", set: { video: [{ type: "vignette" }] } },
      { op: "set-marker", marker: { id: "beat", at: 36, label: "the turn" } },
    ]);
    expect(first.cut.revision).toBe(1);
    expect(first.cut.tracks[0]!.clips.map((c) => [c.id, c.at])).toEqual([["a", 0], ["b", 36]]);
    expect(first.frames).toBe(84);

    const second = editCut(root, scene, [
      { op: "split-clip", clip: "a", at: 24, newId: "a2" },
      { op: "set-clip", clip: "a2", set: { effects: [{ type: "exposure", params: { stops: 0.5 } }] } },
      { op: "add-clip", track: "v1", clip: { id: "c", source: { color: "#303030" }, duration: 24 }, after: "a", ripple: true },
      { op: "remove-clip", clip: "b", ripple: true },
    ]);
    expect(second.cut.revision).toBe(2);
    expect(second.cut.tracks[0]!.clips.map((c) => [c.id, c.at, c.duration])).toEqual([["a", 0, 24], ["c", 24, 24], ["a2", 48, 24]]);
    expect(second.cut.tracks[0]!.clips[2]!.in).toBe(1);
  });

  it("writes nothing when one operation fails, and says which", () => {
    const before = readCut(root, scene).hash;
    expect(() => editCut(root, scene, [
      { op: "set-clip", clip: "a", set: { speed: 2 } },
      { op: "remove-clip", clip: "nobody" },
    ])).toThrow(/operation 2 \(remove-clip\): there is no clip "nobody"/);
    expect(readCut(root, scene).hash).toBe(before);
  });

  it("refuses a result that is not a cut, and a writer that read an older one", () => {
    expect(() => editCut(root, scene, [{ op: "set-clip", clip: "c", set: { at: 0 } }])).toThrow(/overlaps/);
    const stale = readCut(root, scene).cut!;
    editCut(root, scene, [{ op: "set-clip", clip: "a", set: { label: "first" } }]);
    expect(() => writeCut(root, scene, stale, { expectedRevision: stale.revision })).toThrow(/someone changed it/);
  });

  it("leaves what a person locked to the person", () => {
    editCut(root, scene, [{ op: "set-clip", clip: "a", set: { locked: true } }, { op: "set-track", track: "music", set: { locked: true } }]);
    const cut = readCut(root, scene).cut!;
    expect(() => applyCutOps(cut, [{ op: "set-clip", clip: "a", set: { duration: 12 } }], "agent")).toThrow(/locked by a person/);
    expect(() => applyCutOps(cut, [{ op: "remove-clip", clip: "a" }], "agent")).toThrow(/locked by a person/);
    expect(() => applyCutOps(cut, [{ op: "add-clip", track: "music", clip: { id: "m", source: { path: "assets/m.wav" }, duration: 10 } }], "agent")).toThrow(/track "music" is locked/);
    expect(() => applyCutOps(cut, [{ op: "set-clip", clip: "c", set: { locked: true } }], "agent")).toThrow(/only a person/);
    expect(applyCutOps(cut, [{ op: "set-clip", clip: "c", set: { opacity: 0.5 } }], "agent").tracks[0]!.clips[1]!.opacity).toBe(0.5);
    expect(applyCutOps(cut, [{ op: "set-clip", clip: "a", set: { locked: null } }], "person").tracks[0]!.clips[0]!.locked).toBeUndefined();
  });
});

describe.skipIf(!hasFfmpeg)("producing a film", () => {
  let root: string;
  let outside: string;
  const film = filmUnit("tide");
  const shore = sceneUnit("tide", "010-shore");
  const lamp = sceneUnit("tide", "020-lamp");
  const sky = shotUnit("tide", "010-shore", "010-sky");
  const wave = shotUnit("tide", "010-shore", "020-wave");
  const flame = shotUnit("tide", "020-lamp", "010-flame");
  const frames = (path: string) => Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path]).toString().trim());

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "film-produce-"));
    outside = mkdtempSync(join(tmpdir(), "film-camera-"));
    createFilm(root, { slug: "tide", title: "Tide", format: { id: "tiny-24", width: 320, height: 180, fps: 24, loudness: { integrated: -18, truePeak: -1 } } });
    createScene(root, { film: "tide", slug: "010-shore", title: "The shore", sequence: "night" });
    createScene(root, { film: "tide", slug: "020-lamp", title: "The lamp", sequence: "night" });
    createShot(root, { film: "tide", scene: "010-shore", slug: "010-sky", title: "Sky", source: "generated", durationSeconds: 1 });
    createShot(root, { film: "tide", scene: "010-shore", slug: "020-wave", title: "Wave", source: "footage", durationSeconds: 1.5 });
    createShot(root, { film: "tide", scene: "020-lamp", slug: "010-flame", title: "Flame", source: "animation" });
    ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(outside, "A001 C004.mov"));
    ffmpeg("-f", "lavfi", "-i", "color=c=navy:size=320x180:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "tide/scenes/010-shore/shots/010-sky/assets/video/sky.mp4"));
    ffmpeg("-f", "lavfi", "-i", "color=c=orange:size=320x180", "-frames:v", "1", join(root, "tide/scenes/020-lamp/shots/010-flame/assets/images/flame.png"));
    ffmpeg("-f", "lavfi", "-i", "sine=frequency=110:duration=8", join(root, "tide/music/theme.wav"));
  }, 60_000);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("brings footage in once, logged and readable", async () => {
    const first = await ingestFootage(root, "tide", join(outside, "A001 C004.mov"), { tags: ["sea"], scene: "010-shore", shot: "020-wave" });
    expect(first.added).toBe(true);
    expect(first.warnings).toEqual([]);
    expect(first.clip).toMatchObject({ kind: "video", width: 320, height: 180, fps: 24, origin: "camera", linked: false, originalName: "A001 C004.mov" });
    expect(first.clip.id).toMatch(/^a001-c004-[a-f0-9]{8}$/);
    expect(first.clip.audio).toMatchObject({ channels: 1 });
    for (const path of [first.clip.path, first.clip.sheet!, first.clip.proxy!]) expect(existsSync(join(root, "tide", path)), path).toBe(true);
    expect(first.clip.segments).toEqual([{ start: 0, end: 3 }]);
    expect(first.clip.loudness!.integrated!).toBeLessThan(0);

    const again = await ingestFootage(root, "tide", join(outside, "A001 C004.mov"));
    expect(again.added).toBe(false);
    expect(readFootage(root, "tide")).toHaveLength(1);
    annotateFootage(root, "tide", first.clip.id, { notes: "second take, clean", tags: ["sea", "good"] });
    expect(searchFootage(root, "tide", "good clean").map((c) => c.id)).toEqual([first.clip.id]);
    expect(searchFootage(root, "tide", "good", { kind: "audio" })).toEqual([]);
    await expect(ingestFootage(root, "tide", "relative.mov")).rejects.toThrow(/full path/);
  }, 60_000);

  it("cuts each shot from its media", async () => {
    const [clip] = readFootage(root, "tide");
    expect((await assembleCut(root, sky)).cut.tracks[0]!.clips).toEqual([{ id: "take", source: { path: "assets/video/sky.mp4" }, at: 0, duration: 24 }]);
    const cut = await assembleCut(root, wave, { media: `project:${clip!.path}`, in: 0.5 });
    expect(cut.cut.tracks[0]!.clips[0]).toMatchObject({ source: { project: clip!.path }, duration: 36, in: 0.5 });
    expect((await assembleCut(root, flame)).seconds).toBe(4);
    await expect(assembleCut(root, sky)).rejects.toThrow(/already has a cut/);
    expect(cutStatus(root, sky).state).toBe("not-rendered");
    expect(await checkUnitCut(root, wave)).toEqual([]);
  });

  it("says what stands between the film and its render", async () => {
    expect(cutStatus(root, shore).state).toBe("no-cut");
    const assembled = await assembleCut(root, shore, { transition: { type: "dissolve", duration: 6 } });
    expect(assembled.cut.tracks[0]!.clips.map((c) => [c.id, c.source.unit, c.at, c.duration])).toEqual([["010-sky", "010-sky", 0, 24], ["020-wave", "020-wave", 18, 36]]);
    const status = cutStatus(root, shore);
    expect(status.state).toBe("blocked");
    expect(status.reason).toMatch(/shot "010-sky" has no final render yet/);
    await assembleCut(root, lamp);
    await assembleCut(root, film);
    const tree = filmTree(root, "tide");
    expect(tree.totals).toMatchObject({ scenes: 2, shots: 3 });
    expect(tree.scenes.map((s) => [s.slug, s.sequence, s.shots.map((shot) => shot.slug)])).toEqual([["010-shore", "night", ["010-sky", "020-wave"]], ["020-lamp", "night", ["010-flame"]]]);
    expect(nextSteps(tree).map((step) => step.unit)).toEqual(["tide/010-shore/010-sky", "tide/010-shore/020-wave", "tide/010-shore/_", "tide/020-lamp/010-flame", "tide/020-lamp/_", "tide/_/_"]);
    await expect(renderUnit(root, shore, { cascade: false })).rejects.toThrow(/has no final render yet/);
  });

  it("renders the film from its scenes, and each scene from its shots", async () => {
    editCut(root, film, [
      { op: "add-track", track: { id: "score", kind: "audio", role: "music", gain: -6, duck: { under: ["v1"], gain: -8 } } },
      { op: "add-clip", track: "score", clip: { id: "theme", source: { project: "music/theme.wav" }, duration: 150, fadeOut: 24 } },
    ]);
    const seen = new Set<string>();
    const render = await renderUnit(root, film, { onProgress: (p) => seen.add(p.unit) });
    expect([...seen].sort()).toEqual(["tide", "tide/010-shore", "tide/010-shore/010-sky", "tide/010-shore/020-wave", "tide/020-lamp", "tide/020-lamp/010-flame"]);
    expect(render.cascaded.map((r) => r.unit.series)).toEqual(["010-shore", "020-lamp"]);
    expect(render.cascaded[0]!.cascaded.map((r) => r.unit.episode)).toEqual(["010-sky", "020-wave"]);
    // 24 + 36 - 6 of dissolve, then 96 of the lamp.
    expect(render.frames).toBe(150);
    expect(frames(join(root, render.path))).toBe(150);
    expect(render.result!.loudness!.after!.integrated!).toBeCloseTo(-18, 0);
    expect(readPointer(root, film, "final")).toMatchObject({ renderId: render.renderId, frames: 150 });
    expect(readPointer(root, shore, "final")!.mix).toMatch(/\.mix\.wav$/);
    const report = JSON.parse(readFileSync(join(root, render.reportPath), "utf-8"));
    expect(report).toMatchObject({ kind: "CutRender", quality: "final", cut: { revision: 2 } });
    expect(report.children.map((c: { unit: { series: string } }) => c.unit.series)).toEqual(["010-shore", "020-lamp"]);
    expect(report.result.inputs.every((input: { file: string }) => !input.file.startsWith("/"))).toBe(true);
    expect(readFileSync(join(root, "tide", "journal", "events.jsonl"), "utf-8")).toContain("deliverable-current-changed");
    const tree = filmTree(root, "tide");
    expect(tree.totals.byState.current).toBe(5);
    expect(tree.status.state).toBe("current");
    expect(tree.render).toMatchObject({ quality: "final", fresh: true });
    expect(tree.totals.seconds).toBe(6.25);
    expect(nextSteps(tree)).toEqual([]);
  }, 240_000);

  it("renders nothing again while nothing changed", async () => {
    const again = await renderUnit(root, film);
    expect(again.reused).toBe(true);
    expect(again.cascaded).toEqual([]);
  });

  it("re-renders what a change touches, and what is above it", async () => {
    const before = { sky: readPointer(root, sky, "final")!.renderId, lamp: readPointer(root, lamp, "final")!.renderId };
    editCut(root, wave, [{ op: "set-clip", clip: "take", set: { effects: [{ type: "monochrome" }] } }], { editor: "agent" });
    expect(cutStatus(root, wave).state).toBe("stale");
    expect(cutStatus(root, shore).state).toBe("blocked");
    expect(cutStatus(root, film).state).toBe("blocked");
    expect(cutStatus(root, lamp).state).toBe("current");
    const render = await renderUnit(root, film);
    expect(render.reused).toBe(false);
    expect(render.cascaded.map((r) => r.unit.series)).toEqual(["010-shore"]);
    expect(render.cascaded[0]!.cascaded.map((r) => r.unit.episode)).toEqual(["020-wave"]);
    expect(readPointer(root, sky, "final")!.renderId).toBe(before.sky);
    expect(readPointer(root, lamp, "final")!.renderId).toBe(before.lamp);
    expect(cutStatus(root, film).state).toBe("current");
  }, 240_000);

  it("keeps a preview apart from the film's render, and a range apart from both", async () => {
    editCut(root, flame, [{ op: "set-clip", clip: "take", set: { duration: 48 } }]);
    const preview = await renderUnit(root, lamp, { quality: "preview" });
    expect(preview.quality).toBe("preview");
    expect(preview.cascaded.map((r) => r.quality)).toEqual(["preview"]);
    expect(cutStatus(root, lamp)).toMatchObject({ state: "preview" });
    expect(readPointer(root, lamp, "final")!.frames).toBe(96);
    const range = await renderUnit(root, lamp, { quality: "preview", range: { from: 0, to: 12 } });
    expect(range).toMatchObject({ current: false, frames: 12 });
    expect(readPointer(root, lamp, "preview")!.renderId).toBe(preview.renderId);
  }, 120_000);

  it("keeps a scene's cut in step with its shots without losing what was added to it", async () => {
    editCut(root, shore, [
      { op: "set-clip", clip: "020-wave", set: { effects: [{ type: "vignette" }], audio: { gain: -4 } } },
      { op: "add-clip", track: "v1", clip: { id: "black", source: { color: "#000000" }, duration: 12 }, after: "020-wave" },
    ]);
    createShot(root, { film: "tide", scene: "010-shore", slug: "015-gull", title: "A gull", source: "stock", durationSeconds: 0.5 });
    rmSync(join(root, "tide/scenes/010-shore/shots/010-sky"), { recursive: true });
    const result = await assembleCut(root, shore);
    expect(result.notes).toEqual(["015-gull: added, 12 frames (its planned length)", "010-sky: removed (there is no such shot any more)"]);
    const clips = result.cut.tracks[0]!.clips;
    expect(clips.map((c) => [c.id, c.at])).toEqual([["015-gull", 0], ["020-wave", 6], ["black", 42]]);
    expect(clips[1]).toMatchObject({ effects: [{ type: "vignette" }], audio: { gain: -4 }, transitionIn: { type: "dissolve", duration: 6 } });
    expect((await assembleCut(root, shore)).notes).toEqual(["already in step with its 2 shots"]);
  });

  it("shows a frame of a cut, and reads a file before it is used", async () => {
    const frame = await renderUnitFrame(root, wave, 12, { width: 160 });
    expect(frame.path).toMatch(/^tide\/scenes\/010-shore\/shots\/020-wave\/artifacts\/frames\/frame-000012-r\d+\.jpg$/);
    expect(existsSync(join(root, frame.path))).toBe(true);
    const inspection = await inspectMedia(root, wave, `project:${readFootage(root, "tide")[0]!.path}`, { segments: true });
    expect(inspection.media).toMatchObject({ kind: "video", hasAudio: true });
    expect(inspection.sheet).toMatch(/artifacts\/inspect\/.*\.sheet\.jpg$/);
    expect(inspection.segments).toEqual([{ start: 0, end: 3 }]);
    expect(inspection.loudness!.integrated!).toBeLessThan(0);
  }, 60_000);
});
