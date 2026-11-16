// A cut or a journal written by another process reaches the event stream:
// the gateway reads what changed from the files, whoever wrote them.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilm, createScene, createShot, editCut, shotUnit, sceneUnit, filmUnit } from "@studio/film";
import { EventBus, createEvent, type GatewayEvent } from "../src/events/bus.js";
import { ProductionWatch, unitAt } from "../src/events/production-watch.js";
import { WorkspaceWatcher } from "../src/events/watcher.js";

describe("what changed in a production, from the files that changed", () => {
  let root: string;
  let bus: EventBus;
  let events: GatewayEvent[];
  let polled: { unit: string; pipeline: string | undefined }[];
  let watch: ProductionWatch;
  const sky = shotUnit("tide", "010-shore", "010-sky");
  const changed = (path: string) => bus.publish(createEvent("workspace", "file-changed", { path }));
  const cutEvents = () => events.filter((e) => e.type === "cut.changed");

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "gateway-watch-")));
    mkdirSync(join(root, "lessons", "series", "physics", "episodes", "tides", "journal"), { recursive: true });
    writeFileSync(join(root, "lessons", "series", "physics", "episodes", "tides", "journal", "events.jsonl"), "");
    createFilm(root, { slug: "tide", title: "Tide", format: "scope-24" });
    createScene(root, { film: "tide", slug: "010-shore", title: "The shore" });
    createShot(root, { film: "tide", scene: "010-shore", slug: "010-sky", title: "The sky", source: "generated" });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    polled = [];
    bus.subscribe({ send: (event) => events.push(event), close: () => undefined, isAlive: () => true });
    watch = new ProductionWatch({
      bus, root,
      publisher: { pollForEpisode: async (ref, pipeline) => void polled.push({ unit: `${ref.channel}/${ref.series}/${ref.episode}`, pipeline }) },
      pipelineOf: async (ref) => (ref.channel === "tide" ? "film-shot" : undefined),
    }).start();
  });

  it("names the unit a folder of the library is", () => {
    expect(unitAt(root, "tide")).toEqual(filmUnit("tide"));
    expect(unitAt(root, "tide/scenes/010-shore")).toEqual(sceneUnit("tide", "010-shore"));
    expect(unitAt(root, "tide/scenes/010-shore/shots/010-sky")).toEqual(sky);
    expect(unitAt(root, "tide/scenes/010-shore/shots/010-sky/assets")).toBeNull();
    expect(unitAt(root, "tide/footage")).toBeNull();
    expect(unitAt(root, "lessons/series/physics/episodes/tides")).toEqual({ channel: "lessons", series: "physics", episode: "tides" });
    expect(unitAt(root, "lessons/series/physics")).toBeNull();
  });

  it("says a cut changed when another process wrote it, once for each revision", () => {
    const first = editCut(root, sky, [{ op: "add-clip", track: "v1", clip: { id: "sky", source: { color: "#203050" }, duration: 24 } }], { editor: "agent" }).cut;
    changed("tide/scenes/010-shore/shots/010-sky/artifacts/cut.json");
    expect(cutEvents()).toHaveLength(1);
    expect(cutEvents()[0]).toMatchObject({
      channel: "pipeline", episodeSlug: "tide/010-shore/010-sky", data: { unit: "tide/010-shore/010-sky", revision: first.revision, by: "file" },
    });

    // The same file reported again (a rename and a write are two reports) says nothing new.
    changed("tide/scenes/010-shore/shots/010-sky/artifacts/cut.json");
    expect(cutEvents()).toHaveLength(1);

    const second = editCut(root, sky, [{ op: "set-clip", clip: "sky", set: { opacity: 0.5 } }], { editor: "agent" }).cut;
    changed("tide/scenes/010-shore/shots/010-sky/artifacts/cut.json");
    expect(cutEvents()).toHaveLength(2);
    expect(cutEvents()[1]!.data).toMatchObject({ revision: second.revision, previousRevision: first.revision, by: "file" });
  });

  it("does not repeat a cut event this gateway already published for that revision", () => {
    const written = editCut(root, sky, [{ op: "set-clip", clip: "sky", set: { opacity: 1 } }], { editor: "person" }).cut;
    bus.publish(createEvent("pipeline", "cut.changed", { unit: "tide/010-shore/010-sky", by: "person", revision: written.revision }, "tide/010-shore/010-sky"));
    changed("tide/scenes/010-shore/shots/010-sky/artifacts/cut.json");
    expect(cutEvents().map((e) => e.data.by)).toEqual(["person"]);
  });

  it("says nothing for a file that is not a unit's cut", () => {
    writeFileSync(join(root, "tide", "footage", "cut.json"), "{}");
    changed("tide/footage/cut.json");
    changed("tide/scenes/010-shore/shots/010-sky/artifacts/cut.json.lock");
    changed("tide/scenes/010-shore/shots/nobody/artifacts/cut.json");
    changed("lessons/series/physics/episodes/tides/artifacts/cut.json");
    expect(cutEvents()).toEqual([]);
  });

  it("has a unit's stages read again when its journal changed, on the pipeline it runs", async () => {
    changed("tide/scenes/010-shore/shots/010-sky/journal/events.jsonl");
    changed("lessons/series/physics/episodes/tides/journal/events.jsonl");
    changed("lessons/series/physics/episodes/nobody/journal/events.jsonl");
    changed("lessons/journal/events.jsonl");
    await new Promise((done) => setTimeout(done, 20));
    expect(polled).toEqual([
      { unit: "tide/010-shore/010-sky", pipeline: "film-shot" },
      { unit: "lessons/physics/tides", pipeline: undefined },
    ]);
  });

  it("stops listening when it is closed", () => {
    watch.close();
    editCut(root, sky, [{ op: "set-clip", clip: "sky", set: { opacity: 0.25 } }], { editor: "agent" });
    changed("tide/scenes/010-shore/shots/010-sky/artifacts/cut.json");
    expect(cutEvents()).toEqual([]);
  });

  it("hears an edit made on disk through the workspace watcher", async () => {
    const watcher = new WorkspaceWatcher(bus, { root, debounceMs: 50 });
    await watcher.start();
    try {
      await new Promise((done) => setTimeout(done, 200));
      const written = editCut(root, sky, [{ op: "set-clip", clip: "sky", set: { opacity: 0.75 } }], { editor: "agent" }).cut;
      const deadline = Date.now() + 5000;
      // The watcher may first report writes made just before it started: wait for this one.
      const heard = () => cutEvents().find((e) => e.data.revision === written.revision);
      while (!heard() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      expect(heard()?.data).toMatchObject({ unit: "tide/010-shore/010-sky", revision: written.revision, by: "file" });
    } finally {
      await watcher.stop();
    }
  });
});
