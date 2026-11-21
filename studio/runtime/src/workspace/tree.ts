// ---------------------------------------------------------------------------
// What a workspace must have — the doctor's required tree
// ---------------------------------------------------------------------------
// Read by the doctor command (src/workspace/doctor.ts). Workspace init
// (src/workspace/init.ts) creates more than this: working folders that the
// tools fill, and create again when they write into them.
//
// A required path is one the contract depends on, never an empty folder: a
// channel is a git repository (ADR-0045), git keeps no empty folder, and a
// channel cloned or restored without them is whole.
//
// Every path is relative to the workspace root at its level.
// ---------------------------------------------------------------------------

/**
 * What a channel must have to be a channel.
 *
 * Kept to what the contract genuinely depends on. Knowledge folders are
 * created for convenience but are not required: a channel with no
 * `characters/` is perfectly valid, and demanding one would condemn every
 * library created before those folders existed.
 */
export const CHANNEL_TREE = [
  "channel.md",
  "settings.yaml",
  // Explicit container: a directory in here is a series, and nothing else has
  // to be inferred (see studio/contracts/src/layout.mjs).
  "series",
  ".workspace/contract.json",
  ".workspace/metadata.json",
] as const;

/**
 * What a series must have to be a series. See CHANNEL_TREE on knowledge
 * folders. Its episodes live in `episodes/`, the explicit container the
 * doctor descends into; a series with none yet has no such folder in git,
 * and is not broken for it.
 */
export const SERIES_TREE = [
  "series.md",
  "settings.yaml",
  ".workspace/contract.json",
  ".workspace/metadata.json",
] as const;

/**
 * What an episode must have to be an episode. Init also makes its working
 * folders (source/, prompts/, assets/…, attempts/, output/), an empty asset
 * manifest, review threads and journal: the tools write into them and create
 * them when they are missing, and their readers take a missing file for an
 * empty one. Demanding them reported every episode of a channel restored from
 * git as broken. When present, the JSON and JSONL files are still checked.
 */
export const EPISODE_TREE = [
  "episode.yaml",
  ".workspace/contract.json",
  ".workspace/metadata.json",
] as const;

/** All path lists indexed by workspace kind. */
export const TREE_BY_KIND = {
  channel: CHANNEL_TREE,
  series: SERIES_TREE,
  episode: EPISODE_TREE,
} as const;
