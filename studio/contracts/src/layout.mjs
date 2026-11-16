/**
 * Canonical workspace layout — the single source of truth for where things live.
 *
 * Every consumer computes paths through this module rather than joining strings
 * itself. That is the whole point: the previous layout put series directly
 * inside the channel directory, mixed in with the channel's own files, so
 * nothing could tell a series apart from a support folder by looking. The
 * gateway coped with a hardcoded denylist of folder names that are *not*
 * series, which meant adding `characters/` to a channel invented a phantom
 * series.
 *
 * Layout 2 makes containment explicit:
 *
 *   [channel]/
 *     channel.md  settings.yaml  .workspace/
 *     brand/ characters/ references/ skills/ voices/     <- channel knowledge
 *     series/
 *       [series]/
 *         series.md  settings.yaml  .workspace/
 *         visual-bible/ skills/ templates/ sources/ pipelines/  <- series knowledge
 *         episodes/
 *           [episode]/
 *             episode.yaml artifacts/ assets/ attempts/ …
 *
 * A directory inside `series/` is a series. A directory inside `episodes/` is
 * an episode. Nothing has to be guessed, and a channel can grow as many
 * knowledge folders as it likes without any of them being mistaken for content.
 *
 * A film (ADR-0050) is the other kind of project a library holds, beside its
 * channels: one self-contained work, short or feature length. It has the same
 * three levels under other names, and it is produced at each of them:
 *
 *   [film]/
 *     film.yaml  settings.yaml  .workspace/
 *     bible/ characters/ locations/ references/ footage/ music/ …  <- film knowledge
 *     artifacts/ assets/ journal/ output/ …                        <- the whole film's cut and renders
 *     scenes/
 *       [scene]/
 *         scene.yaml  references/ skills/ sources/                 <- scene knowledge
 *         artifacts/ assets/ journal/ output/ …                    <- the scene's cut and renders
 *         shots/
 *           [shot]/
 *             shot.yaml artifacts/ assets/ attempts/ output/ …     <- the shot's takes and renders
 *
 * A directory with a `film.yaml` is a film. Its levels are addressed with the
 * three positions a channel's are — `channel` is the film, `series` the scene,
 * `episode` the shot — so every tool, route and journal that names an episode
 * names a shot the same way. The scene's and the film's own production units
 * are `<film>/<scene>/_` and `<film>/_/_` (`SELF`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/* The container names are shared with the browser, which cannot import this
   module because of `node:path` above. They are defined once, next to the URL
   builder that needs them, and re-exported here so on-disk and in-URL layout
   cannot drift apart. */
import {
  SERIES_CONTAINER,
  EPISODES_CONTAINER,
  SCENES_CONTAINER,
  SHOTS_CONTAINER,
  SELF,
  CONTAINERS,
} from "./library-url.mjs";

export { SERIES_CONTAINER, EPISODES_CONTAINER, SCENES_CONTAINER, SHOTS_CONTAINER, SELF, CONTAINERS };

/** Current layout version, recorded in each workspace contract. */
export const LAYOUT_VERSION = 2;

/**
 * Knowledge folders created at the channel level.
 *
 * These describe the channel itself — who it is and what it knows — as opposed
 * to the series and episodes it contains.
 */
export const CHANNEL_KNOWLEDGE = Object.freeze([
  "brand",
  "characters",
  "references",
  "skills",
  "sources",
  "voices",
]);

/** Knowledge folders created at the series level. */
export const SERIES_KNOWLEDGE = Object.freeze([
  "visual-bible",
  "skills",
  "templates",
  "sources",
  "pipelines",
  "voice-profiles",
]);

/** The file that makes a directory of the library a film. */
export const FILM_MANIFEST = "film.yaml";
/** A scene's own description, in its directory. */
export const SCENE_MANIFEST = "scene.yaml";
/** A shot's own description, in its directory. */
export const SHOT_MANIFEST = "shot.yaml";

/** Knowledge folders created at the film level. */
export const FILM_KNOWLEDGE = Object.freeze([
  "bible",
  "characters",
  "locations",
  "references",
  "skills",
  "sources",
  "voices",
  "footage",
  "music",
]);

/** Knowledge folders created at the scene level. */
export const SCENE_KNOWLEDGE = Object.freeze([
  "references",
  "skills",
  "sources",
]);

/**
 * What every production unit has, whatever its level: an episode, a shot, a
 * scene, a film. The execution service, the journal, the budget and the
 * renders all live in these.
 */
export const UNIT_DIRECTORIES = Object.freeze([
  "artifacts",
  "assets",
  "attempts",
  "journal",
  "output",
  "prompts",
  "reviews",
  "source",
]);

/** Marker directory identifying a directory as a workspace of some kind. */
export const WORKSPACE_DIR = ".workspace";

/** Editorial inputs for series compilers (ADR-0037). */
export const EPISODE_SPEC_PATH = "episode-spec.json";
export const SERIES_TEMPLATE_MANIFEST = "series-template.json";

// ── Project kinds ───────────────────────────────────────────────────────────

/**
 * What kind of project a directory of the library is: a film when it has a
 * `film.yaml`, a channel otherwise.
 *
 * Read from disk on every call, never cached: a film is created while the
 * gateway and the agent are running, and a stale answer would send its first
 * scene into `series/`. A missing directory is a channel, which is what every
 * path builder computed before films existed.
 */
export function projectKind(root, project) {
  return existsSync(join(root, project, FILM_MANIFEST)) ? "film" : "channel";
}

/**
 * The level a three-position reference names.
 *
 * In a channel that is always an episode. In a film it is the shot, the scene
 * (`episode: "_"`) or the film itself (`series: "_"`).
 */
export function unitLevel(root, { channel, series, episode }) {
  if (projectKind(root, channel) !== "film") return "episode";
  if (series === SELF) return "film";
  if (episode === SELF) return "scene";
  return "shot";
}

/**
 * The units a film unit is made of, as references: a scene's shots are found
 * by its caller, this only says where a unit sits. The parent of a shot is its
 * scene's unit, the parent of a scene is the film's, and the film has none.
 */
export function parentUnit({ channel, series, episode }) {
  if (series === SELF) return null;
  if (episode === SELF) return { channel, series: SELF, episode: SELF };
  return { channel, series, episode: SELF };
}

// ── Path builders ───────────────────────────────────────────────────────────

/** `<root>/<channel>` */
export function channelPath(root, channel) {
  return join(root, channel);
}

/** `<root>/<channel>/series`, or `<root>/<film>/scenes`. */
export function seriesContainerPath(root, channel) {
  return join(root, channel, CONTAINERS[projectKind(root, channel)][0]);
}

/** `<root>/<channel>/series/<series>`, or `<root>/<film>/scenes/<scene>`; the film itself for `_`. */
export function seriesPath(root, channel, series) {
  if (series === SELF && projectKind(root, channel) === "film") return channelPath(root, channel);
  return join(seriesContainerPath(root, channel), series);
}

/** `<root>/<channel>/series/<series>/episodes`, or `<root>/<film>/scenes/<scene>/shots`. */
export function episodesContainerPath(root, channel, series) {
  return join(seriesPath(root, channel, series), CONTAINERS[projectKind(root, channel)][1]);
}

/**
 * `<root>/<channel>/series/<series>/episodes/<episode>`, or
 * `<root>/<film>/scenes/<scene>/shots/<shot>`.
 *
 * In a film, `_` is the level itself: `(film, scene, "_")` is the scene's
 * directory and `(film, "_", "_")` the film's. A film has no shot outside a
 * scene, so `(film, "_", shot)` is refused rather than guessed at.
 */
export function episodePath(root, channel, series, episode) {
  if (projectKind(root, channel) === "film") {
    if (series === SELF) {
      if (episode !== SELF) throw new RangeError(`A film's shot is inside a scene: ${channel}/_/${episode} names none`);
      return channelPath(root, channel);
    }
    if (episode === SELF) return seriesPath(root, channel, series);
  }
  return join(episodesContainerPath(root, channel, series), episode);
}

/** `<root>/<film>` */
export function filmPath(root, film) {
  return join(root, film);
}

/** `<root>/<film>/scenes/<scene>` */
export function scenePath(root, film, scene) {
  return join(root, film, SCENES_CONTAINER, scene);
}

/** `<root>/<film>/scenes/<scene>/shots/<shot>` */
export function shotPath(root, film, scene, shot) {
  return join(scenePath(root, film, scene), SHOTS_CONTAINER, shot);
}

/** Exact versioned series-template directory; never resolves "latest". */
export function seriesTemplatePath(root, channel, series, id, version) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new RangeError("Invalid template id");
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) throw new RangeError("An exact template version is required");
  return join(seriesPath(root, channel, series), "templates", id, version);
}

/** References are append-only records alongside releases, never inside a frozen version. */
export function seriesReferencePath(root, channel, series, templateId, referenceId) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(templateId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(referenceId)) {
    throw new RangeError("Invalid template or reference id");
  }
  return join(seriesPath(root, channel, series), "templates", templateId, "references", `${referenceId}.json`);
}

/** A reference's withdrawal: beside its descriptor, append-only like it (avg-jao.6). */
export function seriesReferenceWithdrawalPath(root, channel, series, templateId, referenceId) {
  return seriesReferencePath(root, channel, series, templateId, referenceId).replace(/\.json$/, ".withdrawal.json");
}

/** Path to a channel source: shared material episodes pin, never copy (ADR-0035). */
export function sourcePath(root, channel, name) {
  return join(channelPath(root, channel), "sources", name);
}

/**
 * Path to a workspace of any level, from a partial reference.
 * Supplying only `channel` yields the channel path, and so on.
 */
export function workspacePath(root, { channel, series, episode }) {
  if (episode) {
    if (!channel || !series) throw new Error("episode path requires channel and series");
    return episodePath(root, channel, series, episode);
  }
  if (series) {
    if (!channel) throw new Error("series path requires channel");
    return seriesPath(root, channel, series);
  }
  if (!channel) throw new Error("a path requires at least a channel");
  return channelPath(root, channel);
}

// ── Layout detection ────────────────────────────────────────────────────────

/**
 * Names that layout 1 had to treat as "not a series" when scanning a channel
 * directory. Retained only so a migration can recognise a legacy tree; nothing
 * in layout 2 consults it.
 */
export const LEGACY_SERIES_SUPPORT_DIRECTORIES = Object.freeze([
  "assets",
  "pipelines",
  "rigs",
  "shared-assets",
  "skills",
  "sources",
  "templates",
  "voice-profiles",
]);

/**
 * Whether a channel directory listing looks like layout 2.
 *
 * @param entryNames directory names directly inside the channel
 */
export function isLayout2Channel(entryNames) {
  return entryNames.includes(SERIES_CONTAINER);
}

/**
 * Whether a series directory listing looks like layout 2.
 *
 * @param entryNames directory names directly inside the series
 */
export function isLayout2Series(entryNames) {
  return entryNames.includes(EPISODES_CONTAINER);
}
