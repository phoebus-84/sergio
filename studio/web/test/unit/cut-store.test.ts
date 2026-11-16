import { beforeEach, expect, test, vi } from "vitest";
import type { CutTimeline } from "@studio/contracts/src/cut-timeline.mjs";

/* The store's gateway is a function that answers like the film routes and
   records what it was asked. */
const requests: { method: string; path: string; body?: unknown }[] = [];
let library: CutTimeline | null = null;
let refuseNext: { status: number; error: string; message: string } | null = null;

const status = () => ({ state: library ? "not-rendered" : "no-cut", reason: "", cut: { exists: !!library, revision: library?.revision ?? null, frames: 0, seconds: 0, clips: 0, tracks: 0 }, problems: [], final: null, preview: null, children: [] });

vi.mock("$lib/film-api", () => {
  class FilmApiError extends Error {
    constructor(message: string, readonly status: number, readonly code: string, readonly problems: unknown[] = []) {
      super(message);
    }
  }
  return {
    FilmApiError,
    gatewayUrl: (path: string | null) => path,
    filmApi: async (path: string, init: { method?: string; body?: unknown } = {}) => {
      requests.push({ method: init.method ?? "GET", path, ...(init.body !== undefined ? { body: init.body } : {}) });
      if (refuseNext) {
        const refusal = refuseNext;
        refuseNext = null;
        throw new FilmApiError(refusal.message, refusal.status, refusal.error);
      }
      if (init.method === "PUT") {
        const body = init.body as { cut: CutTimeline };
        library = { ...structuredClone(body.cut), revision: (library?.revision ?? 0) + 1 };
      }
      return { cut: library ? structuredClone(library) : null, exists: !!library, hash: null, status: status() };
    },
  };
});

const { cut, withEffect } = await import("$lib/cut-store.svelte.ts");

const unit = { film: "the-long-shift", scene: "010-car-park", shot: "_" };
const format = { id: "hd720-24", width: 1280, height: 720, fps: 24 };

function scene(): CutTimeline {
  return {
    apiVersion: "studio.video/v1alpha1",
    kind: "CutTimeline",
    unit: { channel: unit.film, series: unit.scene, episode: unit.shot },
    revision: 3,
    format,
    tracks: [
      { id: "v1", kind: "video", role: "picture", clips: [
        { id: "wide", source: { unit: "010-wide" }, at: 0, duration: 72 },
        { id: "close", source: { unit: "020-close" }, at: 72, duration: 48 },
      ] },
      { id: "a1", kind: "audio", role: "ambience", clips: [{ id: "air", source: { path: "assets/audio/air.wav" }, at: 0, duration: 120 }] },
      { id: "a2", kind: "audio", role: "music", duck: { under: ["a1"], gain: -6 }, clips: [] },
    ],
  };
}

beforeEach(async () => {
  requests.length = 0;
  refuseNext = null;
  library = scene();
  // Another unit first, so the next load is of a unit the store has not seen.
  await cut.load({ film: "x", scene: "_", shot: "_" }, format);
  library = scene();
  await cut.load(unit, format);
});

test("the cut is read from the library and the draft starts as a copy of it", () => {
  expect(cut.saved?.revision).toBe(3);
  expect(cut.draft).toEqual(cut.saved);
  expect(cut.dirty).toBe(false);
  expect(cut.frames).toBe(120);
});

test("a unit with no cut opens on an empty draft in the film's format, and is not dirty", async () => {
  library = null;
  await cut.load({ film: "the-long-shift", scene: "040-dawn", shot: "_" }, format);
  expect(cut.saved).toBeNull();
  expect(cut.draft?.format).toEqual(format);
  expect(cut.draft?.tracks.map((track) => track.id)).toEqual(["v1", "a1"]);
  expect(cut.dirty).toBe(false);
});

test("moving a clip makes the draft dirty, and undo takes it back in one step however many moves the drag made", () => {
  for (let at = 73; at <= 90; at++) cut.moveClip("close", at, undefined, "drag-1");
  cut.commit();
  expect(cut.draft?.tracks[0]?.clips[1]?.at).toBe(90);
  expect(cut.dirty).toBe(true);
  expect(cut.historyDepth.past).toBe(1);
  cut.undo();
  expect(cut.draft?.tracks[0]?.clips[1]?.at).toBe(72);
  expect(cut.dirty).toBe(false);
  cut.redo();
  expect(cut.draft?.tracks[0]?.clips[1]?.at).toBe(90);
});

test("trimming a clip's start moves where it begins in its source, and stops at the source's first frame", () => {
  cut.trimClip("close", "start", 84);
  let clip = cut.draft!.tracks[0]!.clips[1]!;
  expect(clip.at).toBe(84);
  expect(clip.duration).toBe(36);
  expect(clip.in).toBe(0.5);

  // Dragging the start earlier than the source has frames for stops where the source starts.
  cut.trimClip("close", "start", 60);
  clip = cut.draft!.tracks[0]!.clips[1]!;
  expect(clip.at).toBe(72);
  expect(clip.in).toBeUndefined();
  expect(clip.duration).toBe(48);
});

test("splitting at the playhead makes two clips that together are the one, the second starting later in the source", () => {
  cut.selection = { kind: "clip", id: "wide" };
  cut.playhead = 24;
  cut.splitAtPlayhead();
  const [first, second] = cut.draft!.tracks[0]!.clips;
  expect(first).toMatchObject({ id: "wide", at: 0, duration: 24 });
  expect(second).toMatchObject({ id: "wide-b", at: 24, duration: 48, in: 1 });
  expect(cut.problems.filter((problem) => problem.severity === "error")).toEqual([]);
});

test("removing a clip with ripple closes the gap; removing a track takes it out of every duck", () => {
  cut.removeClip("wide", true);
  expect(cut.draft!.tracks[0]!.clips).toEqual([expect.objectContaining({ id: "close", at: 0 })]);
  cut.removeTrack("a1");
  expect(cut.draft!.tracks.map((track) => track.id)).toEqual(["v1", "a2"]);
  expect(cut.draft!.tracks[1]!.duck).toBeUndefined();
});

test("a new clip lands at the playhead, or after the picture already there, with an id no clip has", () => {
  cut.playhead = 10;
  cut.addClip("v1", { unit: "020-close" }, 24);
  const added = cut.draft!.tracks[0]!.clips.at(-1)!;
  expect(added).toMatchObject({ id: "020-close", at: 120, duration: 24 });
  cut.addClip("a2", { project: "music/theme.wav" }, 240, "Theme");
  expect(cut.draft!.tracks[2]!.clips[0]).toMatchObject({ id: "theme", at: 10, duration: 240, label: "Theme" });
  expect(cut.selection).toEqual({ kind: "clip", id: "theme" });
});

test("a field set to nothing is removed from the clip, not written as empty", () => {
  cut.setClip("wide", { label: "Establishing", speed: 2 });
  expect(cut.draft!.tracks[0]!.clips[0]).toMatchObject({ label: "Establishing", speed: 2 });
  cut.setClip("wide", { label: null, speed: null } as never);
  expect(cut.draft!.tracks[0]!.clips[0]).toEqual({ id: "wide", source: { unit: "010-wide" }, at: 0, duration: 72 });
});

test("a draft that does not hold says what is wrong as it is made", () => {
  cut.moveClip("close", 40);
  expect(cut.problems.some((problem) => problem.code === "clip-overlap")).toBe(true);
  cut.setClip("close", { transitionIn: { type: "dissolve", duration: 32 } });
  expect(cut.problems.filter((problem) => problem.severity === "error")).toEqual([]);
});

test("saving sends the draft with the revision it was made on, and takes the library's answer", async () => {
  cut.setClip("wide", { label: "Establishing" });
  expect(await cut.save()).toBe(true);
  const put = requests.find((request) => request.method === "PUT")!;
  expect(put.path).toBe("/api/films/the-long-shift/units/010-car-park/_/cut");
  expect((put.body as { expectedRevision: number }).expectedRevision).toBe(3);
  expect(cut.saved?.revision).toBe(4);
  expect(cut.dirty).toBe(false);
});

test("a save the library refuses keeps the draft and says why", async () => {
  cut.setClip("wide", { label: "Establishing" });
  refuseNext = { status: 409, error: "revision-conflict", message: "the cut is at revision 5, not 3" };
  expect(await cut.save()).toBe(false);
  expect(cut.notice).toEqual({ tone: "error", text: "the cut is at revision 5, not 3" });
  expect(cut.draft!.tracks[0]!.clips[0]!.label).toBe("Establishing");
  expect(cut.dirty).toBe(true);
});

test("a cut changed elsewhere does not replace a draft with changes of its own", async () => {
  cut.setClip("wide", { label: "Mine" });
  library = { ...scene(), revision: 4 };
  await cut.load(unit, format);
  expect(cut.draft!.tracks[0]!.clips[0]!.label).toBe("Mine");
  expect(cut.saved?.revision).toBe(4);
  expect(cut.notice?.tone).toBe("error");

  cut.discard();
  expect(cut.draft?.revision).toBe(4);
  expect(cut.dirty).toBe(false);
});

test("assembling is refused while the draft has unsaved changes", async () => {
  cut.setClip("wide", { label: "Mine" });
  const before = requests.length;
  expect(await cut.assemble()).toBe(false);
  expect(requests.length).toBe(before);
});

test("an edge snaps to the nearest clip edge within reach, and stays put otherwise", () => {
  cut.zoom = 4;
  expect(cut.snap(73)).toBe(72);
  expect(cut.snap(100)).toBe(100);
  // A clip does not snap to its own edges.
  cut.moveClip("close", 80);
  expect(cut.snapPoints()).toContain(128);
  expect(cut.snapPoints("close")).not.toContain(128);
});

test("an effect chain is changed as a new list", () => {
  const chain = [{ type: "vignette" }, { type: "grain", params: { amount: 0.2 } }];
  expect(withEffect(chain, 1, null)).toEqual([{ type: "vignette" }]);
  expect(withEffect(chain, 2, { type: "sepia" })).toHaveLength(3);
  expect(withEffect(chain, 0, { type: "vignette", enabled: false })[0]).toEqual({ type: "vignette", enabled: false });
  expect(chain).toHaveLength(2);
});
