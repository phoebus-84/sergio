/**
 * Library URLs — the browser-safe half of the workspace layout.
 *
 * `layout.mjs` is the source of truth for where things live on disk, but it
 * imports `node:path` and so cannot be bundled into the studio. The container
 * names and the URL shape are the parts the browser needs, and duplicating them
 * in the web app would mean the studio could drift from the gateway silently —
 * the failure mode being a 404 on every image, which reads as "the asset is
 * missing" rather than "the path is wrong".
 *
 * So they live here, with no Node dependency, and `layout.mjs` imports them.
 * One definition, two consumers.
 */

/** Directory inside a channel that holds its series. */
export const SERIES_CONTAINER = "series";

/** Directory inside a series that holds its episodes. */
export const EPISODES_CONTAINER = "episodes";

/** Directory inside a film that holds its scenes (ADR-0050). */
export const SCENES_CONTAINER = "scenes";

/** Directory inside a scene that holds its shots. */
export const SHOTS_CONTAINER = "shots";

/**
 * "This level itself", in a film's address.
 *
 * A film is produced at three levels — the shot, the scene, the whole film —
 * and each is a production unit with its own journal, cut and renders. A unit
 * is still addressed by three segments, so the scene's own unit is
 * `<film>/<scene>/_` and the film's is `<film>/_/_`. No slug can be `_`:
 * names beginning with an underscore are reserved at every level.
 */
export const SELF = "_";

/** The containers of each project kind: what holds its second and third level. */
export const CONTAINERS = Object.freeze({
  channel: Object.freeze([SERIES_CONTAINER, EPISODES_CONTAINER]),
  film: Object.freeze([SCENES_CONTAINER, SHOTS_CONTAINER]),
});

/**
 * Path segments for a workspace level, from a partial reference.
 *
 * Supplying only `channel` yields the channel, adding `series` yields the
 * series, and so on — matching `workspacePath` in `layout.mjs`. A reference
 * with `kind: "film"` reads the same three positions as film, scene and shot
 * (the browser knows the kind from the library listing; it cannot look on
 * disk as `layout.mjs` does).
 */
export function librarySegments({ kind, channel, series, episode }) {
  if (!channel) return [];
  const [second, third] = CONTAINERS[kind === "film" ? "film" : "channel"];
  const segments = [channel];
  // In a film, `_` names the level itself: `<film>/_/_` is the film.
  if (series && series !== SELF) {
    segments.push(second, series);
    if (episode && episode !== SELF) segments.push(third, episode);
  }
  return segments;
}

/**
 * The `/library/…` path for a file inside a workspace level.
 *
 * Every segment is percent-encoded, so a channel or file named with a space or
 * a `#` resolves rather than truncating at the fragment. `relative` may contain
 * `/` separators; each of its segments is encoded individually so the slashes
 * survive as path structure.
 *
 * Returns null when there is no channel to anchor to, or when `relative` tries
 * to climb out of the level — the static route would reject it anyway, but a
 * caller that gets null can say "no preview" instead of firing a doomed request.
 */
export function libraryUrlPath(ref, relative = "") {
  const segments = librarySegments(ref);
  if (segments.length === 0) return null;

  const parts = String(relative)
    .split("/")
    .filter((part) => part !== "" && part !== ".");

  if (parts.some((part) => part === "..")) return null;

  return (
    "/library/" +
    [...segments, ...parts].map((part) => encodeURIComponent(part)).join("/")
  );
}
