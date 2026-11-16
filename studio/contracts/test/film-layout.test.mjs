import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectKind, unitLevel, parentUnit, channelPath, seriesContainerPath, seriesPath, episodesContainerPath,
  episodePath, filmPath, scenePath, shotPath, workspacePath, sourcePath, SELF, FILM_MANIFEST,
} from "../src/layout.mjs";
import { librarySegments, libraryUrlPath } from "../src/library-url.mjs";

describe("a film in the library (ADR-0050)", () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "film-layout-"));
    mkdirSync(join(root, "tide"));
    writeFileSync(join(root, "tide", FILM_MANIFEST), "kind: Film\n");
    mkdirSync(join(root, "lessons"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("is a directory with a film.yaml; anything else is a channel", () => {
    assert.equal(projectKind(root, "tide"), "film");
    assert.equal(projectKind(root, "lessons"), "channel");
    assert.equal(projectKind(root, "not-there"), "channel");
  });

  it("keeps a channel's paths as they were", () => {
    assert.equal(seriesContainerPath(root, "lessons"), join(root, "lessons", "series"));
    assert.equal(seriesPath(root, "lessons", "poems"), join(root, "lessons", "series", "poems"));
    assert.equal(episodesContainerPath(root, "lessons", "poems"), join(root, "lessons", "series", "poems", "episodes"));
    assert.equal(episodePath(root, "lessons", "poems", "ep01"), join(root, "lessons", "series", "poems", "episodes", "ep01"));
    assert.equal(unitLevel(root, { channel: "lessons", series: "poems", episode: "ep01" }), "episode");
  });

  it("reads the same three positions as film, scene and shot", () => {
    assert.equal(seriesContainerPath(root, "tide"), join(root, "tide", "scenes"));
    assert.equal(seriesPath(root, "tide", "010-beach"), join(root, "tide", "scenes", "010-beach"));
    assert.equal(episodesContainerPath(root, "tide", "010-beach"), join(root, "tide", "scenes", "010-beach", "shots"));
    assert.equal(episodePath(root, "tide", "010-beach", "020-wave"), join(root, "tide", "scenes", "010-beach", "shots", "020-wave"));
    assert.equal(episodePath(root, "tide", "010-beach", "020-wave"), shotPath(root, "tide", "010-beach", "020-wave"));
    assert.equal(workspacePath(root, { channel: "tide", series: "010-beach" }), scenePath(root, "tide", "010-beach"));
    assert.equal(sourcePath(root, "tide", "ocean-library"), join(root, "tide", "sources", "ocean-library"));
  });

  it("addresses the scene's and the film's own units with _", () => {
    assert.equal(episodePath(root, "tide", "010-beach", SELF), scenePath(root, "tide", "010-beach"));
    assert.equal(episodePath(root, "tide", SELF, SELF), filmPath(root, "tide"));
    assert.equal(seriesPath(root, "tide", SELF), channelPath(root, "tide"));
    assert.equal(unitLevel(root, { channel: "tide", series: "010-beach", episode: "020-wave" }), "shot");
    assert.equal(unitLevel(root, { channel: "tide", series: "010-beach", episode: SELF }), "scene");
    assert.equal(unitLevel(root, { channel: "tide", series: SELF, episode: SELF }), "film");
  });

  it("refuses a shot outside a scene", () => {
    assert.throws(() => episodePath(root, "tide", SELF, "020-wave"), /inside a scene/);
  });

  it("names each unit's parent", () => {
    assert.deepEqual(parentUnit({ channel: "tide", series: "010-beach", episode: "020-wave" }), { channel: "tide", series: "010-beach", episode: SELF });
    assert.deepEqual(parentUnit({ channel: "tide", series: "010-beach", episode: SELF }), { channel: "tide", series: SELF, episode: SELF });
    assert.equal(parentUnit({ channel: "tide", series: SELF, episode: SELF }), null);
  });

  it("builds a film's URLs when the reference says it is one", () => {
    assert.deepEqual(librarySegments({ kind: "film", channel: "tide", series: "010-beach", episode: "020-wave" }), ["tide", "scenes", "010-beach", "shots", "020-wave"]);
    assert.deepEqual(librarySegments({ kind: "film", channel: "tide", series: "010-beach", episode: SELF }), ["tide", "scenes", "010-beach"]);
    assert.deepEqual(librarySegments({ kind: "film", channel: "tide", series: SELF, episode: SELF }), ["tide"]);
    assert.deepEqual(librarySegments({ channel: "lessons", series: "poems", episode: "ep01" }), ["lessons", "series", "poems", "episodes", "ep01"]);
    assert.equal(libraryUrlPath({ kind: "film", channel: "tide", series: "010-beach", episode: SELF }, "output/a b.mp4"), "/library/tide/scenes/010-beach/output/a%20b.mp4");
  });
});
