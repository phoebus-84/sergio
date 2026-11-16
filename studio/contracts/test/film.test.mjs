import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FILM_FORMATS, filmFormat, DEFAULT_FILM_FORMAT, validateFilm, validateScene, validateShot, validateManifest,
  sceneOrder, shotOrder, runningOrder, compareSlugs, timecode, formatRuntime, SHOT_SOURCES, SHOT_SOURCE_DESCRIPTIONS,
} from "../src/film.mjs";
import { check } from "../src/schema-lite.mjs";

const film = (extra = {}) => ({
  apiVersion: "studio.video/v1alpha1", kind: "Film", slug: "tide", title: "Tide",
  format: { id: "hd-24", width: 1920, height: 1080, fps: 24 }, ...extra,
});

describe("film formats", () => {
  it("have unique ids, even sizes and a default", () => {
    assert.equal(new Set(FILM_FORMATS.map((f) => f.id)).size, FILM_FORMATS.length);
    for (const f of FILM_FORMATS) {
      assert.equal(f.width % 2, 0, f.id);
      assert.equal(f.height % 2, 0, f.id);
      assert.deepEqual(validateFilm(film({ format: { id: f.id, width: f.width, height: f.height, fps: f.fps } })), [], f.id);
    }
    assert.ok(filmFormat(DEFAULT_FILM_FORMAT));
    assert.throws(() => { FILM_FORMATS[0].fps = 1; }, TypeError);
  });
});

describe("film manifests", () => {
  it("accept a film, a scene and a shot", () => {
    assert.deepEqual(validateFilm(film()), []);
    assert.deepEqual(validateScene({ apiVersion: "studio.video/v1alpha1", kind: "Scene", slug: "010", title: "Beach" }), []);
    assert.deepEqual(validateShot({ apiVersion: "studio.video/v1alpha1", kind: "Shot", slug: "010", title: "Wave", source: "footage" }), []);
    assert.deepEqual(validateManifest("shot", { apiVersion: "studio.video/v1alpha1", kind: "Shot", slug: "010", title: "Wave", source: "stock" }), []);
  });

  it("refuse what is not a mapping, naming the level", () => {
    assert.match(validateScene(null)[0].message, /scene manifest/);
    assert.match(validateFilm([])[0].message, /film manifest/);
    assert.throws(() => validateManifest("episode", {}), RangeError);
  });

  it("let a film carry its own format under its own id", () => {
    assert.deepEqual(validateFilm(film({ format: { id: "super8", width: 1440, height: 1080, fps: 24 } })), []);
    assert.deepEqual(validateFilm(film({ format: { id: "hd-24", width: 1920, height: 1080, fps: 30 } })).map((p) => p.code), ["format-mismatch"]);
  });

  it("describe every source a shot can have", () => {
    for (const source of SHOT_SOURCES) assert.ok(SHOT_SOURCE_DESCRIPTIONS[source], source);
  });
});

describe("running order", () => {
  it("sorts slugs as a script numbers them", () => {
    assert.deepEqual(["10-b", "2-a", "10a-c", "1-z"].sort(compareSlugs), ["1-z", "2-a", "10-b", "10a-c"]);
  });

  it("puts declared names first, then the rest by slug, and reports what is missing", () => {
    assert.deepEqual(runningOrder(["c", "gone", "a"], ["a", "b", "c", "10", "9"]), { order: ["c", "a", "9", "10", "b"], missing: ["gone"], unlisted: ["9", "10", "b"] });
  });

  it("gives each scene its sequence and act", () => {
    const order = sceneOrder(film({ sequences: [{ id: "open", act: "I", scenes: ["020", "010"] }, { id: "close", scenes: ["040"] }] }), ["010", "020", "030", "040"]);
    assert.deepEqual(order.scenes, [
      { scene: "020", sequence: "open", act: "I" },
      { scene: "010", sequence: "open", act: "I" },
      { scene: "040", sequence: "close", act: null },
      { scene: "030", sequence: null, act: null },
    ]);
    assert.deepEqual(order.unlisted, ["030"]);
  });

  it("orders a film with no manifest by slug", () => {
    assert.deepEqual(sceneOrder(null, ["b", "a"]).scenes.map((s) => s.scene), ["a", "b"]);
    assert.deepEqual(shotOrder({ shots: ["z"] }, ["a", "z"]).order, ["z", "a"]);
  });
});

describe("timecode", () => {
  it("counts frames at the film's rate", () => {
    assert.equal(timecode(0, 24), "00:00:00:00");
    assert.equal(timecode(24 * 3661 + 5, 24), "01:01:01:05");
  });

  it("reads a runtime as a person says it", () => {
    assert.equal(formatRuntime(12.52), "12.5s");
    assert.equal(formatRuntime(245), "4m 05s");
    assert.equal(formatRuntime(5520), "1h 32m");
    assert.equal(formatRuntime(Number.NaN), "–");
  });
});

describe("the browser's schema reader", () => {
  it("refuses a keyword it does not read rather than accepting everything", () => {
    assert.throws(() => check({}, { type: "object", patternProperties: {} }, {}), /does not read "patternProperties"/);
    assert.throws(() => check({}, { $ref: "other.json#/$defs/X" }, {}), /cannot resolve/);
  });

  it("reports every problem with its path", () => {
    const schema = { type: "object", required: ["a"], additionalProperties: false, properties: { a: { type: "array", items: { type: "integer", minimum: 1 } } } };
    assert.deepEqual(check(schema, schema, { a: [1, 0, "x"], b: 1 }).map((p) => [p.code, p.path]), [
      ["minimum", "$.a[1]"], ["type", "$.a[2]"], ["additionalProperties", "$.b"],
    ]);
  });
});
