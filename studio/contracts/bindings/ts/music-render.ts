/**
 * TypeScript bindings generated from music-render.schema.json
 * Schema: https://schemas.studio.video/v1alpha1/music-render.schema.json
 * Auto-generated — do not edit directly.
 */

export type Hash = string;

export type Path = string;

export type Level = number | null;

export interface Part {
  /** The part's label in the code; $1, $2… for unlabelled ones. */
  name: string;
  /** Written muted in the code. */
  muted: boolean;
  /** It plays in this file. */
  selected: boolean;
  /** Its label solos it: the engine plays such parts alone. */
  solo: boolean;
}

export interface Stem {
  part: string;
  path: Path;
  hash: Hash;
  /** Integrated, LUFS, at the gain it has in the mix. */
  loudness: Level;
  /** dBFS. */
  peak: Level;
}

export interface MusicRender {
  apiVersion: "studio.video/v1alpha1";
  kind: "MusicRender";
  engine: {
    name: "strudel";
    version: string;
  };
  /** The piece: the code this file was rendered from. */
  source: {
    path: Path;
    hash: Hash;
  };
  /** What was asked, as it was given: the stretch, the parts, the tail or the loop, the seed, the level. */
  request: Record<string, unknown>;
  tempo: {
    cps: number;
    cyclesPerMinute: number;
  };
  /** The cycles rendered. */
  range: {
    from: number;
    to: number;
  };
  output: {
    path: Path;
    hash: Hash;
    durationSeconds: number;
    /** Seconds that are the cycles themselves; what follows is the tail. */
    bodySeconds: number;
    sampleRate: number;
    channels: 1 | 2;
    /** The tail is folded over the start: the file repeats without a seam. */
    loop: boolean;
  };
  parts: Part[];
  level: {
    /** The one gain applied to the render, dB. */
    gain: number;
    basis: "loudness" | "peak" | "given" | "none";
    /** The peak ceiling kept the file under the loudness asked for. */
    held: boolean;
    /** Integrated, LUFS. */
    loudness: Level;
    /** dBFS. */
    peak: Level;
  };
  /** The file measured: spectrum by band, stereo image, level through time (@av/strudel's AudioAnalysis). */
  analysis: Record<string, unknown>;
  /** Every file of the workspace the piece loaded as a sample, by its path. */
  inputs: Record<string, Hash>;
  /** What the piece took from the network, when that was allowed. */
  fetched: {
    url: string;
    hash: Hash;
    bytes: number;
  }[];
  stems: Stem[];
  /** What a person should know or listen for, in plain words. */
  concerns: string[];
  createdAt: string;
}
