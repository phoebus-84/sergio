// Type declarations for the canonical workspace layout.
// Kept alongside layout.mjs so TypeScript consumers get the same contract the
// runtime and gateway rely on at runtime.

export declare const LAYOUT_VERSION: number;
export declare const SERIES_CONTAINER: string;
export declare const EPISODES_CONTAINER: string;
export declare const SCENES_CONTAINER: string;
export declare const SHOTS_CONTAINER: string;
export declare const SELF: "_";
export declare const CONTAINERS: Readonly<Record<"channel" | "film", readonly [string, string]>>;
export declare const FILM_MANIFEST: "film.yaml";
export declare const SCENE_MANIFEST: "scene.yaml";
export declare const SHOT_MANIFEST: "shot.yaml";
export declare const FILM_KNOWLEDGE: readonly string[];
export declare const SCENE_KNOWLEDGE: readonly string[];
export declare const UNIT_DIRECTORIES: readonly string[];
export declare const WORKSPACE_DIR: string;
export declare const EPISODE_SPEC_PATH: "episode-spec.json";
export declare const SERIES_TEMPLATE_MANIFEST: "series-template.json";
export declare const CHANNEL_KNOWLEDGE: readonly string[];
export declare const SERIES_KNOWLEDGE: readonly string[];
export declare const LEGACY_SERIES_SUPPORT_DIRECTORIES: readonly string[];

export type ProjectKind = "channel" | "film";
export type UnitLevel = "episode" | "film" | "scene" | "shot";
export interface UnitRef { channel: string; series: string; episode: string }

/** A film when the directory has a film.yaml, a channel otherwise. Read from disk on every call. */
export declare function projectKind(root: string, project: string): ProjectKind;
/** The level a three-position reference names: an episode in a channel; the shot, scene or film in a film. */
export declare function unitLevel(root: string, ref: UnitRef): UnitLevel;
/** The unit a film unit belongs to; null for the film itself. */
export declare function parentUnit(ref: UnitRef): UnitRef | null;
export declare function filmPath(root: string, film: string): string;
export declare function scenePath(root: string, film: string, scene: string): string;
export declare function shotPath(root: string, film: string, scene: string, shot: string): string;
export declare function channelPath(root: string, channel: string): string;
export declare function seriesContainerPath(root: string, channel: string): string;
export declare function seriesPath(root: string, channel: string, series: string): string;
export declare function episodesContainerPath(root: string, channel: string, series: string): string;
export declare function episodePath(root: string, channel: string, series: string, episode: string): string;
export declare function seriesTemplatePath(root: string, channel: string, series: string, id: string, version: string): string;
export declare function seriesReferencePath(root: string, channel: string, series: string, templateId: string, referenceId: string): string;
export declare function seriesReferenceWithdrawalPath(root: string, channel: string, series: string, templateId: string, referenceId: string): string;
export declare function sourcePath(root: string, channel: string, name: string): string;
export declare function workspacePath(
  root: string,
  ref: { channel?: string; series?: string; episode?: string },
): string;
export declare function isLayout2Channel(entryNames: readonly string[]): boolean;
export declare function isLayout2Series(entryNames: readonly string[]): boolean;
