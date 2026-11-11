// Type declarations for the library URL contract.

/** A partial reference to a workspace level. */
export interface LevelReference {
  /** The kind of project `channel` names. Default: a channel. */
  kind?: "channel" | "film" | undefined;
  channel?: string | undefined;
  series?: string | undefined;
  episode?: string | undefined;
}

/** Directory inside a channel that holds its series. */
export const SERIES_CONTAINER: string;

/** Directory inside a series that holds its episodes. */
export const EPISODES_CONTAINER: string;

/** Directory inside a film that holds its scenes. */
export const SCENES_CONTAINER: string;

/** Directory inside a scene that holds its shots. */
export const SHOTS_CONTAINER: string;

/** "This level itself" in a film's address: `<film>/_/_` is the film's own unit. */
export const SELF: "_";

/** The second- and third-level containers of each project kind. */
export const CONTAINERS: Readonly<Record<"channel" | "film", readonly [string, string]>>;

/** Path segments for a workspace level, deepest level the reference supports. */
export function librarySegments(ref: LevelReference): string[];

/**
 * The `/library/…` path for a file inside a workspace level, or null when
 * there is no channel to anchor to or the path climbs out of the level.
 */
export function libraryUrlPath(
  ref: LevelReference,
  relative?: string,
): string | null;
