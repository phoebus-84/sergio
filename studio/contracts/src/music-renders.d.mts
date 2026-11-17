export declare const MUSIC_EXTENSION: ".strudel";
export declare const MUSIC_DIR: "music";
export declare const MUSIC_RENDER_SUFFIX: ".music.json";
export interface MusicPart { name: string; muted: boolean; selected: boolean; solo: boolean }
export interface MusicStem { part: string; path: string; hash: string; loudness: number | null; peak: number | null }
export interface MusicRenderRecord {
  apiVersion: "studio.video/v1alpha1";
  kind: "MusicRender";
  engine: { name: "strudel"; version: string };
  source: { path: string; hash: string };
  request: Record<string, unknown>;
  tempo: { cps: number; cyclesPerMinute: number };
  range: { from: number; to: number };
  output: { path: string; hash: string; durationSeconds: number; bodySeconds: number; sampleRate: number; channels: 1 | 2; loop: boolean };
  parts: MusicPart[];
  level: { gain: number; basis: "loudness" | "peak" | "given" | "none"; held: boolean; loudness: number | null; peak: number | null };
  analysis: Record<string, unknown>;
  inputs: Record<string, string>;
  fetched: { url: string; hash: string; bytes: number }[];
  stems: MusicStem[];
  concerns: string[];
  createdAt: string;
}
export declare function validateMusicRender(doc: unknown): { code: string; path: string; message: string }[];
