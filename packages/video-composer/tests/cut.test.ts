// The cut renderer: its catalog and planning as pure functions, then real
// renders with FFmpeg — a few seconds of generated picture and tone.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listEffects, validateEffect, validateCut, cutFrames, divide, renderCut, renderCutFrame, checkCut, renderSize, CutError,
  probeFile, contactSheet, detectSegments, makeProxy, extractStill, measureLoudness,
  type Cut,
} from "../src/index.js";
import { duckExpression, pictureJob, soundJob } from "../src/cut/graph.js";
import { buses } from "../src/cut/plan.js";
import { effectFilters, tempoFilters } from "../src/cut/effects.js";
import type { MediaInfo } from "../src/cut/types.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

const info = (file: string, extra: Partial<MediaInfo> = {}): MediaInfo => ({
  file, kind: "video", duration: 10, width: 320, height: 180, fps: 24, hasVideo: true, hasAudio: true, audioChannels: 2,
  sampleRate: 48000, videoCodec: "h264", audioCodec: "aac", hasAlpha: false, size: 1, mtimeMs: 1, ...extra,
});

const cutOf = (tracks: Cut["tracks"], master?: Cut["master"]): Cut => ({ width: 320, height: 180, fps: 24, tracks, ...(master ? { master } : {}) });

describe("the effect catalog", () => {
  it("describes every effect and every parameter", () => {
    const effects = listEffects();
    expect(effects.length).toBeGreaterThan(35);
    expect(new Set(effects.map((e) => `${e.domain}:${e.type}`)).size).toBe(effects.length);
    for (const effect of effects) {
      expect(effect.title, effect.type).toBeTruthy();
      expect(effect.description, effect.type).toBeTruthy();
      expect("filters" in effect).toBe(false);
      for (const [name, param] of Object.entries(effect.params)) expect(param.description, `${effect.type}.${name}`).toBeTruthy();
    }
    expect(listEffects("audio").every((e) => e.domain === "audio")).toBe(true);
  });

  it("builds filters from every effect's defaults", () => {
    const context = { width: 320, height: 180, fps: 24, clipFrames: 48, frameOffset: 0, resolveFile: (f: string) => `/luts/${f}` };
    for (const effect of listEffects()) {
      const params = effect.type === "lut" ? { file: "look.cube" } : {};
      const filters = effectFilters(effect.domain, [{ type: effect.type, params }], context);
      for (const filter of filters) expect(filter, effect.type).toMatch(/^[a-z0-9_]+(=|$)/);
    }
    expect(effectFilters("video", [{ type: "lut", params: { file: "a:b.cube" } }], context)[0]).toContain("/luts/a\\:b.cube");
    expect(effectFilters("video", [{ type: "blur", enabled: false }], context)).toEqual([]);
  });

  it("refuses what it does not know, saying where", () => {
    expect(validateEffect("video", { type: "sparkle" }, "$.e")[0]).toMatchObject({ code: "unknown-effect", path: "$.e.type" });
    expect(validateEffect("video", { type: "reverb" }, "$.e")[0]).toMatchObject({ code: "wrong-domain" });
    expect(validateEffect("video", { type: "exposure", params: { stops: 9 } }, "$.e")[0]).toMatchObject({ code: "bad-param", path: "$.e.params.stops" });
    expect(validateEffect("video", { type: "exposure", params: { ev: 1 } }, "$.e")[0]).toMatchObject({ code: "unknown-param" });
    expect(validateEffect("video", { type: "lut" }, "$.e")[0]).toMatchObject({ code: "missing-param" });
    expect(validateEffect("video", { type: "lut", params: { file: "look.png" } }, "$.e")[0]).toMatchObject({ code: "bad-param" });
    expect(validateEffect("audio", { type: "reverb", params: { space: "hall", mix: 0.2 } }, "$.e")).toEqual([]);
  });

  it("slows sound past atempo's own limit", () => {
    expect(tempoFilters(1)).toEqual([]);
    expect(tempoFilters(2)).toEqual(["atempo=2"]);
    expect(tempoFilters(0.2)).toEqual(["atempo=0.5", "atempo=0.5", "atempo=0.8"]);
  });
});

describe("planning a cut", () => {
  it("divides the timeline where clips begin and end", () => {
    expect(divide([0, 100, 250, 400, 700], 0, 700, 240, 720)).toEqual([[0, 250], [250, 700]]);
    expect(divide([], 0, 2000, 240, 720)).toEqual([[0, 720], [720, 1440], [1440, 2000]]);
    expect(divide([50], 10, 60, 240, 720)).toEqual([[10, 60]]);
  });

  it("refuses overlaps, unknown effects and sound on a colour", () => {
    const cut = cutOf([
      { id: "v", kind: "video", clips: [
        { id: "a", media: { file: "/a.mp4" }, at: 0, duration: 48 },
        { id: "b", media: { file: "/b.mp4" }, at: 40, duration: 48, effects: [{ type: "sparkle" }] },
      ] },
      { id: "s", kind: "audio", duck: { under: ["nobody"], gain: -10 }, clips: [{ id: "c", media: { color: "#000000" }, at: 0, duration: 10 }] },
    ]);
    expect(validateCut(cut).map((p) => p.code).sort()).toEqual(["clip-overlap", "clip-source", "duck-unknown", "unknown-effect"]);
    expect(cutFrames(cut)).toBe(88);
  });

  it("refuses a rate sound cannot follow", () => {
    expect(validateCut({ ...cutOf([{ id: "v", kind: "video", clips: [{ id: "a", media: { color: "#000000" }, at: 0, duration: 7 }] }]), fps: 23 }).map((p) => p.code)).toContain("bad-rate");
  });

  it("warns when a clip asks for more than its source has", () => {
    const cut = cutOf([{ id: "v", kind: "video", clips: [{ id: "a", media: { file: "/a.mp4" }, at: 0, duration: 480, in: 2 }] }]);
    const problems = validateCut(cut, new Map([["/a.mp4", info("/a.mp4")]]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ code: "clip-past-source", severity: "warning" });
  });

  it("renders a preview smaller and a final at the cut's size", () => {
    expect(renderSize({ width: 1920, height: 1080 }, "preview")).toEqual({ width: 960, height: 540 });
    expect(renderSize({ width: 2048, height: 858 }, "preview")).toEqual({ width: 960, height: 402 });
    expect(renderSize({ width: 1920, height: 1080 }, "final")).toEqual({ width: 1920, height: 1080 });
    expect(renderSize({ width: 640, height: 360 }, "preview")).toEqual({ width: 640, height: 360 });
  });
});

describe("a window as an FFmpeg run", () => {
  const media = new Map([["/a.mp4", info("/a.mp4")], ["/t.png", info("/t.png", { kind: "image", duration: null, hasAudio: false, hasAlpha: true })]]);
  const cut = cutOf([
    { id: "v1", kind: "video", clips: [{ id: "a", media: { file: "/a.mp4" }, at: 0, duration: 96, in: 1, speed: 2, transitionOut: { type: "dissolve", duration: 12 }, effects: [{ type: "exposure", params: { stops: 0.5 } }] }] },
    { id: "v2", kind: "video", clips: [{ id: "t", media: { file: "/t.png" }, at: 24, duration: 48, fit: "contain", transitionIn: { type: "wipe-left", duration: 12 } }] },
    { id: "m", kind: "audio", gain: -6, duck: { under: ["v1"], gain: -12 }, clips: [{ id: "music", media: { file: "/a.mp4" }, at: 0, duration: 96, fadeOut: 24 }] },
  ]);

  it("seeks into a clip where the window starts inside it", () => {
    const job = pictureJob(cut, [48, 96], media, { width: 320, height: 180, resolveFile: (f) => f });
    // 48 frames into a clip at twice the speed that starts 1 s into its source: 1 + 2 * 2 = 5 s.
    expect(job.args.slice(0, 6)).toEqual(["-ss", "5", "-t", "5", "-i", "/a.mp4"]);
    const graph = job.args[job.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("setpts=(PTS-STARTPTS)/2");
    expect(graph).toContain("exposure=exposure=0.5");
    // The dissolve out is where the clip says, on the clip's own clock: 84 frames in, for 12.
    expect(graph).toContain("setpts=PTS+2/TB,fade=t=out:st=3.5:d=0.5:alpha=1");
    expect(graph).toContain("pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black@0");
    expect(job.args.slice(-2)).toEqual(["-frames:v", "48"]);
    expect(job.files).toEqual(["/a.mp4", "/t.png"]);
  });

  it("masks a wipe only in the windows it happens in", () => {
    const first = pictureJob(cut, [0, 48], media, { width: 320, height: 180, resolveFile: (f) => f });
    expect(first.args[first.args.indexOf("-filter_complex") + 1]).toContain("alphamerge");
  });

  it("ducks a bed under the tracks it names", () => {
    const all = buses(cut, media);
    expect(all.map((b) => b.id)).toEqual(["v1", "m"]);
    const job = soundJob(cut, all[1]!, [0, 96], all);
    const graph = job.args[job.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("afade=t=out:st=3:d=1:curve=qsin");
    expect(graph).toContain("eval=frame");
    expect(graph).toContain("atrim=end_sample=192000");
    expect(duckExpression([[1, 2], [2.2, 3], [9, 10]], -10, 0.25, 0.6)).toBe(
      "-10*max(min(clip((t-0.75)/0.25\\,0\\,1)\\,clip((3.6-t)/0.6\\,0\\,1))\\,min(clip((t-8.75)/0.25\\,0\\,1)\\,clip((10.6-t)/0.6\\,0\\,1)))",
    );
  });
});

describe.skipIf(!hasFfmpeg)("rendering with FFmpeg", () => {
  let dir: string;
  const file = (name: string) => join(dir, name);
  const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const frames = (path: string) => Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path]).toString().trim());
  const meanLuma = (path: string) => {
    const out = spawnSync("ffmpeg", ["-hide_banner", "-i", path, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-frames:v", "1", "-f", "null", "-"]).stderr.toString();
    return Number(/YAVG=([0-9.]+)/.exec(out)?.[1]);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cut-render-"));
    ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=14", "-f", "lavfi", "-i", "sine=frequency=440:duration=14", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file("a.mp4"));
    ffmpeg("-f", "lavfi", "-i", "color=c=white:size=640x360:rate=30:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", file("white.mp4"));
    ffmpeg("-f", "lavfi", "-i", "color=c=red@0.5:size=200x60,format=rgba", "-frames:v", "1", file("title.png"));
    ffmpeg("-f", "lavfi", "-i", "sine=frequency=220:duration=14", "-ac", "1", file("music.wav"));
    writeFileSync(file("identity.cube"), ["LUT_3D_SIZE 2", "0 0 0", "1 0 0", "0 1 0", "1 1 0", "0 0 1", "1 0 1", "0 1 1", "1 1 1", ""].join("\n"));
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const film = (): Cut => cutOf([
    { id: "v1", kind: "video", clips: [
      { id: "a", media: { file: file("a.mp4") }, at: 0, duration: 264, audio: { gain: -6, fadeOut: 12 } },
      { id: "w", media: { file: file("white.mp4") }, at: 252, duration: 60, transitionIn: { type: "dissolve", duration: 12 }, effects: [{ type: "lut", params: { file: "identity.cube" } }] },
      { id: "end", media: { color: "#000000" }, at: 312, duration: 12, transitionIn: { type: "fade", duration: 6 } },
    ] },
    { id: "v2", kind: "video", clips: [
      { id: "title", media: { file: file("title.png") }, at: 12, duration: 48, fit: "contain", transitionIn: { type: "wipe-right", duration: 12 }, transitionOut: { type: "dissolve", duration: 12 }, effects: [{ type: "saturation", params: { amount: 0.5 } }] },
    ] },
    { id: "music", kind: "audio", gain: -3, duck: { under: ["v1"], gain: -9 }, effects: [{ type: "highpass", params: { frequency: 60 } }], clips: [
      { id: "theme", media: { file: file("music.wav") }, at: 0, duration: 324, fadeIn: 12, fadeOut: 24, effects: [{ type: "reverb", params: { space: "room" } }] },
    ] },
  ], { video: [{ type: "vignette" }], audio: [{ type: "limiter" }], loudness: { integrated: -18, truePeak: -1 } });

  it("probes picture, sound and stills", async () => {
    expect(await probeFile(file("a.mp4"))).toMatchObject({ kind: "video", width: 320, height: 180, fps: 24, hasAudio: true, hasAlpha: false });
    expect(await probeFile(file("title.png"))).toMatchObject({ kind: "image", duration: null, hasAlpha: true, hasAudio: false });
    expect(await probeFile(file("music.wav"))).toMatchObject({ kind: "audio", hasVideo: false, audioChannels: 1 });
    await expect(probeFile(file("nope.mp4"))).rejects.toMatchObject({ code: "missing-file" });
    await expect(probeFile(file("identity.cube"))).rejects.toMatchObject({ code: "unreadable-media" });
  });

  it("renders a cut to the frame, to its loudness, and keeps what it made", async () => {
    const seen: string[] = [];
    const result = await renderCut(film(), {
      output: file("out/film.mp4"), workDir: file("work"), keepMix: true, resolveFile: (f) => file(f),
      onProgress: (p) => { if (!seen.includes(p.phase)) seen.push(p.phase); },
    });
    expect(seen).toEqual(["probe", "picture", "sound", "mix", "master", "mux"]);
    expect(result.frames).toBe(324);
    expect(frames(result.output)).toBe(324);
    expect(result).toMatchObject({ width: 320, height: 180, fps: 24, hasAudio: true, quality: "final", durationSeconds: 13.5 });
    expect(result.work).toMatchObject({ pictureChunks: 2, pictureReused: 0, soundChunks: 2, soundReused: 0 });
    expect(result.loudness!.after!.integrated!).toBeCloseTo(-18, 0);
    expect(result.loudness!.after!.truePeak!).toBeLessThanOrEqual(-0.5);
    expect(result.mix).toBe(file("out/film.mix.wav"));
    expect(existsSync(result.mix!)).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.warnings).toEqual([]);
    const probe = await probeFile(result.output);
    expect(probe.duration!).toBeCloseTo(13.5, 1);
    expect(readdirSync(file("work/pieces")).some((name) => name.includes(".partial"))).toBe(false);

    // The same cut again: nothing is rendered twice.
    const again = await renderCut(film(), { output: file("out/film-2.mp4"), workDir: file("work"), resolveFile: (f) => file(f) });
    expect(again.work).toMatchObject({ pictureChunks: 2, pictureReused: 2, soundChunks: 2, soundReused: 2 });
    expect(again.sha256).toBe(result.sha256);

    // One clip changed: the window it is in is rendered, the other is kept.
    const changed = film();
    changed.tracks[0]!.clips[1]!.effects = [{ type: "exposure", params: { stops: -1 } }];
    const third = await renderCut(changed, { output: file("out/film-3.mp4"), workDir: file("work"), resolveFile: (f) => file(f) });
    expect(third.work).toMatchObject({ pictureChunks: 2, pictureReused: 1, soundReused: 2 });
    expect(third.sha256).not.toBe(result.sha256);
  }, 180_000);

  it("shows the frame the timeline shows: a dissolve halfway, a fade to black", async () => {
    const cut = film();
    cut.master = {};
    const start = await renderCutFrame(cut, 240, file("frames/a.png"), { resolveFile: (f) => file(f) });
    const middle = await renderCutFrame(cut, 258, file("frames/mid.png"), { resolveFile: (f) => file(f) });
    const white = await renderCutFrame(cut, 300, file("frames/white.png"), { resolveFile: (f) => file(f) });
    const black = await renderCutFrame(cut, 323, file("frames/black.png"), { resolveFile: (f) => file(f) });
    const [ya, ym, yw, yb] = [start, middle, white, black].map(meanLuma) as [number, number, number, number];
    expect(yw).toBeGreaterThan(225);
    expect(ym).toBeGreaterThan(ya + 15);
    expect(ym).toBeLessThan(yw - 15);
    expect(yb).toBeLessThan(20);
  }, 60_000);

  it("renders a range, and a preview no wider than 960", async () => {
    const result = await renderCut({ ...film(), width: 1920, height: 1080 }, {
      output: file("out/range.mp4"), workDir: file("work-preview"), quality: "preview", range: { from: 240, to: 288 }, resolveFile: (f) => file(f),
    });
    expect(result).toMatchObject({ frames: 48, width: 960, height: 540, mix: null });
    expect(frames(result.output)).toBe(48);
  }, 60_000);

  it("refuses a cut whose source is missing, before rendering anything", async () => {
    const cut = film();
    cut.tracks[0]!.clips[0]!.media = { file: file("gone.mp4") };
    const error = await renderCut(cut, { output: file("out/never.mp4"), workDir: file("work-never") }).catch((e) => e);
    expect(error).toBeInstanceOf(CutError);
    expect(error.code).toBe("invalid-cut");
    expect(error.problems[0]).toMatchObject({ code: "missing-file" });
    expect(existsSync(file("out/never.mp4"))).toBe(false);
    expect((await checkCut(cut)).map((p) => p.code)).toContain("missing-file");
  });

  it("stops when asked", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(renderCut(film(), { output: file("out/stopped.mp4"), workDir: file("work-stop"), signal: controller.signal, resolveFile: (f) => file(f) }))
      .rejects.toMatchObject({ name: expect.stringMatching(/CutError|MediaError|ProcessCancelledError/) });
    expect(existsSync(file("out/stopped.mp4"))).toBe(false);
  });

  it("reads footage before it is cut: a sheet, its segments, a proxy, a still, its level", async () => {
    ffmpeg("-f", "lavfi", "-i", "color=c=black:size=320x180:rate=24:duration=2", "-f", "lavfi", "-i", "color=c=white:size=320x180:rate=24:duration=2",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", file("reel.mp4"));
    expect(await detectSegments(file("reel.mp4"))).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
    const sheet = await contactSheet(file("a.mp4"), file("sheets/a.jpg"), { columns: 3, rows: 2, tileWidth: 160 });
    expect(sheet.instants).toHaveLength(6);
    expect(sheet.instants[0]).toBeCloseTo(14 / 12, 2);
    const sheetInfo = await probeFile(sheet.output);
    expect(sheetInfo.width!).toBeGreaterThan(3 * 160);
    expect((await probeFile(await makeProxy(file("a.mp4"), file("proxies/a.mp4"), { height: 90 }))).height).toBe(90);
    expect((await probeFile(await extractStill(file("a.mp4"), 1, file("stills/a.jpg"), { width: 160 }))).width).toBe(160);
    const level = await measureLoudness(file("music.wav"));
    expect(level.integrated!).toBeLessThan(0);
    expect(level.truePeak!).toBeLessThan(0);
  }, 60_000);
});
