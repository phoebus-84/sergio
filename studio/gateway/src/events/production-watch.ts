// ---------------------------------------------------------------------------
// What changed in a production, read from the files that changed
// ---------------------------------------------------------------------------
// The browser shows a cut and a pipeline that the agent, the CLI and a person
// with a text editor all write, from other processes. Only this gateway's own
// routes used to say so on the event stream: an edit the agent made with
// `pva_edit_cut` reached an open editor at its next poll, and a stage that
// moved reached it never (#91: `pollForEpisode` had no caller).
//
// The library is the record, so the files say what happened whoever wrote
// them. The workspace watcher already reports each changed file; this turns
// two of those reports into the events the browser listens for:
//
//   <unit>/artifacts/cut.json     → `cut.changed`, with the revision it left
//                                   and the one it reached
//   <unit>/journal/events.jsonl   → the unit's stages are read again, and
//                                   the publisher says which moved
//
// A cut event this gateway already published for the same revision is not
// said twice: its routes name the revision they wrote.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { CUT_TIMELINE_PATH } from "@studio/contracts/src/cut-timeline.mjs";
import { JOURNAL_RELATIVE_PATH } from "@studio/contracts/src/journal.mjs";
import {
  EPISODES_CONTAINER, SCENES_CONTAINER, SERIES_CONTAINER, SHOTS_CONTAINER, episodePath, projectKind,
} from "@studio/contracts/src/layout.mjs";
import { cutPath, filmUnit, readCut, sceneUnit, shotUnit, unitKey, type UnitRef } from "@studio/film";
import { createEvent, type EventBus, type EventChannel, type EventSubscriber, type GatewayEvent } from "./bus.js";
import type { EventPublisher } from "./publisher.js";

const posix = (path: string): string => (sep === "/" ? path : path.split(sep).join("/"));

/** The film unit a library-relative folder is, or null when it is not one. */
function filmUnitAt(parts: string[]): UnitRef | null {
  const [film, scenes, scene, shots, shot, ...rest] = parts;
  if (!film) return null;
  if (scenes === undefined) return filmUnit(film);
  if (scenes !== SCENES_CONTAINER || !scene) return null;
  if (shots === undefined) return sceneUnit(film, scene);
  if (shots !== SHOTS_CONTAINER || !shot || rest.length > 0) return null;
  return shotUnit(film, scene, shot);
}

/** The production unit a library-relative folder is: a film's, or a series' episode. */
export function unitAt(root: string, folder: string): UnitRef | null {
  const parts = posix(folder).split("/").filter(Boolean);
  const [project, container, series, episodes, episode, ...rest] = parts;
  if (!project) return null;
  if (projectKind(root, project) === "film") return filmUnitAt(parts);
  if (container !== SERIES_CONTAINER || !series || episodes !== EPISODES_CONTAINER || !episode || rest.length > 0) return null;
  return { channel: project, series, episode };
}

export interface ProductionWatchOptions {
  bus: EventBus;
  root: string;
  /** Reads a unit's stages again and publishes the ones that moved. */
  publisher?: Pick<EventPublisher, "pollForEpisode">;
  /** The pipeline a unit runs, when it is not the default one. */
  pipelineOf?: (ref: UnitRef) => Promise<string | undefined>;
}

export class ProductionWatch implements EventSubscriber {
  readonly channels: EventChannel[] = ["workspace", "pipeline"];
  private readonly revisions = new Map<string, number>();
  private alive = true;

  constructor(private readonly options: ProductionWatchOptions) {}

  /** Listen to the bus. Returns the watch, so the server can stop it. */
  start(): this {
    this.options.bus.subscribe(this);
    return this;
  }

  close(): void {
    this.alive = false;
    this.options.bus.unsubscribe(this);
  }

  isAlive(): boolean {
    return this.alive;
  }

  send(event: GatewayEvent): void {
    if (event.channel === "pipeline") {
      // A cut event that names its revision: said already, not to be said again.
      if (event.type === "cut.changed" && typeof event.data.unit === "string" && typeof event.data.revision === "number") {
        this.revisions.set(event.data.unit, event.data.revision);
      }
      return;
    }
    if (event.type !== "file-changed" || typeof event.data.path !== "string") return;
    const path = posix(event.data.path);
    if (path.endsWith(`/${CUT_TIMELINE_PATH}`)) this.cutChanged(path.slice(0, -CUT_TIMELINE_PATH.length - 1));
    else if (path.endsWith(`/${posix(JOURNAL_RELATIVE_PATH)}`)) this.journalChanged(path.slice(0, -posix(JOURNAL_RELATIVE_PATH).length - 1));
  }

  private cutChanged(folder: string): void {
    const { root, bus } = this.options;
    try {
      const ref = unitAt(root, folder);
      if (!ref || projectKind(root, ref.channel) !== "film") return;
      if (cutPath(root, ref) !== join(root, ...folder.split("/"), ...CUT_TIMELINE_PATH.split("/"))) return;
      const revision = readCut(root, ref).cut?.revision;
      if (typeof revision !== "number") return;
      const key = unitKey(ref);
      const previous = this.revisions.get(key);
      if (previous === revision) return;
      bus.publish(createEvent("pipeline", "cut.changed", {
        unit: key, revision, ...(previous !== undefined ? { previousRevision: previous } : {}), by: "file",
      }, key));
    } catch { /* a cut that cannot be read says nothing; the editor shows why when it is opened */ }
  }

  private journalChanged(folder: string): void {
    const { root, publisher, pipelineOf } = this.options;
    if (!publisher) return;
    let ref: UnitRef | null;
    try {
      ref = unitAt(root, folder);
      const dir = join(root, ...folder.split("/"));
      if (!ref || episodePath(root, ref.channel, ref.series, ref.episode) !== dir || !existsSync(join(dir, JOURNAL_RELATIVE_PATH))) return;
    } catch {
      return;
    }
    const unit = ref;
    void (async () => {
      const pipeline = pipelineOf ? await pipelineOf(unit).catch(() => undefined) : undefined;
      await publisher.pollForEpisode(unit, pipeline);
    })().catch(() => { /* an episode that cannot be read publishes nothing */ });
  }
}
