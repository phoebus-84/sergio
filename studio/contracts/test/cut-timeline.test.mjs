import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCutTimeline, hasCutErrors, emptyCut, sequenceClips, cutDuration, cutSeconds, allClips, unitSources,
  sourceKind, secondsToFrames, CUT_TIMELINE_PATH, TRACK_ROLES, TRANSITIONS,
} from "../src/cut-timeline.mjs";

const unit = { channel: "tide", series: "010-beach", episode: "_" };
const format = { id: "hd-24", width: 1920, height: 1080, fps: 24 };

describe("a cut timeline", () => {
  it("lives in the unit's artifacts", () => {
    assert.equal(CUT_TIMELINE_PATH, "artifacts/cut.json");
    assert.ok(TRACK_ROLES.includes("dialogue"));
    assert.ok(TRANSITIONS.includes("dissolve"));
  });

  it("starts empty, valid, and warns that it has no clip", () => {
    const cut = emptyCut(unit, format);
    const problems = validateCutTimeline(cut);
    assert.deepEqual(problems.map((p) => [p.code, p.severity]), [["empty-cut", "warning"]]);
    assert.equal(hasCutErrors(problems), false);
    assert.equal(cutDuration(cut), 0);
  });

  it("lays sources end to end, dissolving when asked", () => {
    const items = [
      { id: "a", source: { unit: "010" }, duration: 48 },
      { id: "b", source: { unit: "020" }, duration: 24, label: "second" },
      { id: "c", source: { unit: "030" }, duration: 6 },
    ];
    assert.deepEqual(sequenceClips(items).map((c) => [c.id, c.at]), [["a", 0], ["b", 48], ["c", 72]]);
    const dissolved = sequenceClips(items, { transition: { type: "dissolve", duration: 12 } });
    assert.deepEqual(dissolved.map((c) => [c.id, c.at, c.transitionIn?.duration]), [["a", 0, undefined], ["b", 36, 12], ["c", 54, 6]]);
    const cut = emptyCut(unit, format);
    cut.tracks[0].clips = dissolved;
    assert.deepEqual(validateCutTimeline(cut), []);
    assert.equal(cutDuration(cut), 60);
    assert.equal(cutSeconds(cut), 2.5);
    assert.deepEqual(unitSources(cut), ["010", "020", "030"]);
    assert.equal(allClips(cut).length, 3);
  });

  it("knows a clip's source by its one key", () => {
    assert.equal(sourceKind({ unit: "a" }), "unit");
    assert.equal(sourceKind({ project: "music/x.wav" }), "project");
    assert.equal(sourceKind({ unit: "a", path: "b" }), null);
    assert.equal(sourceKind({}), null);
    assert.equal(sourceKind(null), null);
  });

  it("never rounds a clip to no frame", () => {
    assert.equal(secondsToFrames(0.001, 24), 1);
    assert.equal(secondsToFrames(2.5, 24), 60);
  });

  it("says where and how a cut is wrong", () => {
    const cut = emptyCut(unit, format);
    cut.tracks[0].clips = [
      { id: "a", source: { unit: "010" }, at: 0, duration: 48 },
      { id: "b", source: { unit: "020" }, at: 40, duration: 48 },
    ];
    const [problem] = validateCutTimeline(cut);
    assert.equal(problem.code, "clip-overlap");
    assert.equal(problem.path, "$.tracks[0].clips[1].at");
    assert.match(problem.message, /overlaps "a" by 8 frame/);
    assert.equal(hasCutErrors([problem]), true);
  });

  it("lets sound clips overlap on a track: they sum", () => {
    const cut = emptyCut(unit, format);
    cut.tracks[1].clips = [
      { id: "a", source: { path: "assets/a.wav" }, at: 0, duration: 48 },
      { id: "b", source: { path: "assets/b.wav" }, at: 10, duration: 48 },
    ];
    assert.deepEqual(validateCutTimeline(cut), []);
  });
});
