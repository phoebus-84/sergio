// ---------------------------------------------------------------------------
// Speech through a ComfyUI server's Qwen3-TTS nodes
// ---------------------------------------------------------------------------
// `pva_synthesize_speech` speaks through the local Qwen worker unless the
// caller names another provider: the provider is never switched for them.
// This module is the branch for provider "comfyui-qwen": a ComfyUI server
// the operator runs (their own GPU, so $0 and no spend ledger), with the
// ComfyUI-Qwen-TTS nodes. Four ways to speak, one per @av/comfyui-speech
// workflow:
//
//   voice: "<speaker>"                 a CustomVoice preset speaker
//   voice: "saved:<name>"              a voice saved on the server
//   referenceAudioPath                 the voice of a recording of this workspace
//   referenceAudioPath + cleanReference  the same, after the server has cut the
//                                      recording and separated its voice from
//                                      music and noise
//
// The server is configuration, never code: AVG_COMFYUI_URL, or `url` in the
// library's .render/comfyui.json (AVG_COMFYUI_CONFIG names another file).
// A server that listens only on its own loopback is reached through a tunnel
// the operator opens; this module sees only the URL.
//
// ComfyUI saves FLAC; the take is a WAV, so FFmpeg converts it here. Qwen
// times no words: the take is aligned afterwards like any other.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  cleanAndClone,
  ComfyUiError,
  createComfyUiClient,
  DEFAULT_REFERENCE_SECONDS,
  nodeSettingsOf,
  probeSpeech,
  QWEN_NODE_SPEAKERS,
  resolveComfyUiConfig,
  speakWithClonedVoice,
  speakWithSavedVoice,
  speakWithSpeaker,
  type ComfyUiSpeechConfig,
  type SpeechOptions,
  type SpeechProbe,
  type SpeechResult,
} from "@av/comfyui-speech";

export const COMFYUI_PROVIDER = "comfyui-qwen";
export const COMFYUI_URL_ENV = "AVG_COMFYUI_URL";
export const COMFYUI_CONFIG_ENV = "AVG_COMFYUI_CONFIG";
/** Where the library keeps the server's settings, beside the render hosts. */
export const COMFYUI_CONFIG_RELATIVE = join(".render", "comfyui.json");
const SAVED_PREFIX = "saved:";

/** The server's settings: the environment's URL over the library's file. */
export function comfyUiConfig(libraryRoot: string, env: NodeJS.ProcessEnv = process.env): ComfyUiSpeechConfig {
  return resolveComfyUiConfig({ url: env[COMFYUI_URL_ENV], file: env[COMFYUI_CONFIG_ENV] || join(libraryRoot, COMFYUI_CONFIG_RELATIVE) });
}

const NOT_CONFIGURED = `${COMFYUI_URL_ENV} is not set and the library's ${COMFYUI_CONFIG_RELATIVE.replace(/\\/g, "/")} names no url`;

/** What the tool says about this provider, in its description. */
export function comfyUiSpeechTerms(): string {
  return `free, on the operator's own ComfyUI server (${COMFYUI_URL_ENV}); voice is a speaker (${QWEN_NODE_SPEAKERS.join(", ")}) or saved:<name> for a voice saved there; ` +
    "or referenceAudioPath clones the voice of a recording in this workspace (referenceText: exactly what it says — much closer with it), " +
    `and cleanReference first cuts it (referenceStart, referenceDuration, default the first ${DEFAULT_REFERENCE_SECONDS} s) and separates the voice from music and noise`;
}

/** Whether the server answers and what it can do, for pva_capability_status. */
export async function comfyUiSpeechStatus(libraryRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<{ available: boolean; detail: string }> {
  let config: ComfyUiSpeechConfig;
  try {
    config = comfyUiConfig(libraryRoot, env);
  } catch (e) {
    return { available: false, detail: e instanceof Error ? e.message : String(e) };
  }
  if (!config.url) return { available: false, detail: NOT_CONFIGURED };
  let probe: SpeechProbe;
  try {
    probe = await probeSpeech(createComfyUiClient({ baseUrl: config.url, requestTimeoutMs: 5_000 }));
  } catch (e) {
    return { available: false, detail: `${e instanceof Error ? e.message : String(e)}; a server that listens on its own loopback needs the operator's tunnel open` };
  }
  const ready = Object.entries(probe.workflows).filter(([, w]) => w.available).map(([name]) => name);
  const missing = [...new Set(Object.values(probe.workflows).flatMap((w) => w.missingNodes))];
  const what = `ComfyUI ${probe.version ?? "?"} at ${config.url}${probe.devices.length > 0 ? ` (${probe.devices.join(", ")})` : ""}`;
  if (!probe.workflows.speaker.available && !probe.workflows.clone.available) {
    return { available: false, detail: `${what} answers but lacks the Qwen3-TTS nodes (${missing.join(", ")})` };
  }
  return {
    available: true,
    detail: `${what}: pva_synthesize_speech with provider "${COMFYUI_PROVIDER}", $0; workflows ${ready.join(", ")}` +
      (missing.length > 0 ? `; missing nodes ${missing.join(", ")}` : "") +
      `; saved voices ${probe.savedVoices.length > 0 ? probe.savedVoices.map((v) => `${SAVED_PREFIX}${v}`).join(", ") : "none"}`,
  };
}

/** The voices the server offers, for pva_voices; null when no server is configured. */
export async function comfyUiVoices(libraryRoot: string): Promise<{ speakers: string[]; savedVoices: string[] } | null> {
  const config = comfyUiConfig(libraryRoot);
  if (!config.url) return null;
  const probe = await probeSpeech(createComfyUiClient({ baseUrl: config.url, requestTimeoutMs: 5_000 }));
  return { speakers: probe.speakers, savedVoices: probe.savedVoices };
}

/** FLAC to 16-bit PCM WAV, at the rate and channels it has. */
async function flacToWav(flac: Buffer): Promise<Buffer> {
  const work = mkdtempSync(join(tmpdir(), "pva-comfyui-speech-"));
  try {
    const input = join(work, "speech.flac");
    const output = join(work, "speech.wav");
    writeFileSync(input, flac);
    const { status, stderr } = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map_metadata", "-1", "-c:a", "pcm_s16le", output], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let err = "";
      child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf-8"); });
      child.on("error", (e) => resolve({ status: null, stderr: e.message }));
      child.on("close", (code) => resolve({ status: code, stderr: err }));
    });
    if (status !== 0) throw new Error(`FFmpeg could not turn the server's FLAC into a WAV: ${stderr.trim().slice(-500) || "ffmpeg not found"}`);
    return readFileSync(output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Seconds of a canonical PCM WAV, from its header. */
function wavSeconds(wav: Buffer): number {
  const data = wav.indexOf("data", 12, "latin1");
  const byteRate = wav.readUInt32LE(28);
  if (data < 0 || byteRate === 0) return 0;
  return Math.min(wav.readUInt32LE(data + 4), wav.length - data - 8) / byteRate;
}

export interface ComfyUiSpeechRequest {
  /** The workspace the WAV is written in. */
  dir: string;
  libraryRoot: string;
  sceneId: string;
  text: string;
  /** A speaker, or saved:<name>; absent when a reference is cloned. */
  voice?: string;
  /** The recording to clone, already checked to be inside the workspace. */
  reference?: { absolutePath: string; relativePath: string };
  referenceText?: string;
  cleanReference?: boolean;
  referenceStart?: number;
  referenceDuration?: number;
  saveVoiceAs?: string;
  language?: string;
  seed?: number;
  temperature?: number;
  repetitionPenalty?: number;
  instruct?: string;
  signal?: AbortSignal;
}

export interface ComfyUiSpeechResult {
  audioPath: string;
  receiptPath: string;
  cleanedReferencePath?: string;
  durationSeconds: number;
  elapsedSeconds: number;
  method: string;
  receipt: Record<string, unknown>;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export async function synthesizeWithComfyUi(r: ComfyUiSpeechRequest): Promise<ComfyUiSpeechResult> {
  // Everything that can be refused is refused before the server is asked.
  const cleaning = (["referenceStart", "referenceDuration", "saveVoiceAs"] as const).filter((k) => r[k] !== undefined);
  if (r.reference) {
    if (r.voice !== undefined) throw new Error("give voice or referenceAudioPath, not both: a reference is the voice");
    if (r.instruct) throw new Error("a cloned voice takes no instruct: its manner is the reference's");
    if (!r.cleanReference && cleaning.length > 0) throw new Error(`${cleaning.join(", ")} ${cleaning.length > 1 ? "belong" : "belongs"} to cleanReference: true (cut, separate the voice, then clone)`);
  } else {
    const referenceOnly = [...(["referenceText", "cleanReference"] as const).filter((k) => r[k] !== undefined), ...cleaning];
    if (referenceOnly.length > 0) throw new Error(`${referenceOnly.join(", ")} ${referenceOnly.length > 1 ? "need" : "needs"} referenceAudioPath: the recording to clone`);
    if (!r.voice) throw new Error(`provider "${COMFYUI_PROVIDER}" needs voice (${QWEN_NODE_SPEAKERS.join(", ")}, or ${SAVED_PREFIX}<name>) or referenceAudioPath`);
    if (r.voice.startsWith("clone:")) throw new Error(`${r.voice} is enrolled in the local voice worker, not on the ComfyUI server: there, use ${SAVED_PREFIX}<name> or referenceAudioPath`);
  }
  const saved = r.voice?.startsWith(SAVED_PREFIX) ? r.voice.slice(SAVED_PREFIX.length) : undefined;
  if (saved !== undefined && r.instruct) throw new Error("a saved voice takes no instruct: its manner is the reference's");

  const config = comfyUiConfig(r.libraryRoot);
  if (!config.url) throw new Error(NOT_CONFIGURED);
  const client = createComfyUiClient({ baseUrl: config.url });
  const settings = nodeSettingsOf(config);
  const options: SpeechOptions = {
    client,
    text: r.text,
    settings,
    ...(r.language ? { language: r.language } : {}),
    ...(r.seed !== undefined ? { seed: r.seed } : {}),
    ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
    ...(r.repetitionPenalty !== undefined ? { repetitionPenalty: r.repetitionPenalty } : {}),
    ...(config.outputPrefix ? { outputPrefix: config.outputPrefix } : {}),
    ...(config.timeoutSeconds ? { timeoutMs: config.timeoutSeconds * 1000 } : {}),
    ...(r.signal ? { signal: r.signal } : {}),
  };

  let speech: SpeechResult;
  let method: string;
  let referenceBytes: Buffer | undefined;
  try {
    if (r.reference) {
      referenceBytes = readFileSync(r.reference.absolutePath);
      const reference = {
        // Only the extension leaves this machine: the package names the upload by its content's hash.
        reference: { bytes: referenceBytes, filename: basename(r.reference.absolutePath) },
        ...(r.referenceText ? { referenceText: r.referenceText } : {}),
        ...(config.inputSubfolder ? { inputSubfolder: config.inputSubfolder } : {}),
      };
      if (r.cleanReference) {
        method = "clean-and-clone";
        speech = await cleanAndClone({
          ...options,
          ...reference,
          ...(r.referenceStart !== undefined ? { referenceStart: r.referenceStart } : {}),
          ...(r.referenceDuration !== undefined ? { referenceDuration: r.referenceDuration } : {}),
          ...(r.saveVoiceAs ? { saveVoiceAs: r.saveVoiceAs } : {}),
        });
      } else {
        method = "voice-clone";
        speech = await speakWithClonedVoice({ ...options, ...reference });
      }
    } else if (saved !== undefined) {
      method = "saved-voice";
      speech = await speakWithSavedVoice({ ...options, voice: saved });
    } else {
      method = "preset-speaker";
      speech = await speakWithSpeaker({ ...options, speaker: r.voice!, ...(r.instruct ? { instruct: r.instruct } : {}) });
    }
  } catch (e) {
    if (e instanceof ComfyUiError && e.code === "unreachable") throw new Error(`${e.message}: is the server running, and the operator's tunnel to it open?`);
    throw e;
  }

  const wav = await flacToWav(speech.audio);
  const narrationDir = join(r.dir, "artifacts", "narration");
  const audioPath = join(narrationDir, `${r.sceneId}.wav`);
  const receiptPath = join(narrationDir, `${r.sceneId}.synthesis.json`);
  mkdirSync(narrationDir, { recursive: true });
  writeFileSync(audioPath, wav);
  // The separated voice the model learned from, kept to be listened to: a bad separation explains a bad clone.
  const cleanedName = `${r.sceneId}.cleaned-reference.flac`;
  if (speech.cleanedReference) writeFileSync(join(narrationDir, cleanedName), speech.cleanedReference.audio);

  const durationSeconds = Math.round(wavSeconds(wav) * 1000) / 1000;
  const sampling = {
    ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
    ...(r.repetitionPenalty !== undefined ? { repetitionPenalty: r.repetitionPenalty } : {}),
  };
  const receipt = {
    provider: COMFYUI_PROVIDER,
    method,
    workflow: speech.workflow,
    promptId: speech.promptId,
    model: `qwen3-tts-${settings.model}`,
    precision: settings.precision,
    ...(r.voice !== undefined ? { requestedVoice: r.voice } : {}),
    ...(r.reference && referenceBytes ? {
      reference: {
        path: r.reference.relativePath.replace(/\\/g, "/"),
        audioSha256: sha256(referenceBytes),
        ...(r.referenceText ? { textSha256: sha256(r.referenceText) } : { timbreOnly: true }),
        ...(r.cleanReference ? {
          cleaned: true,
          startSeconds: r.referenceStart ?? 0,
          durationSeconds: r.referenceDuration ?? DEFAULT_REFERENCE_SECONDS,
          cleanedReference: `artifacts/narration/${cleanedName}`,
          ...(speech.cleanedReference ? { cleanedReferenceSha256: sha256(speech.cleanedReference.audio) } : {}),
        } : {}),
        ...(r.saveVoiceAs ? { savedAs: r.saveVoiceAs } : {}),
      },
    } : {}),
    language: r.language ?? "auto",
    seed: speech.seed,
    ...(r.instruct ? { instruct: r.instruct } : {}),
    ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
    text: r.text,
    wav: `artifacts/narration/${r.sceneId}.wav`,
    wavSha256: sha256(wav),
    durationSeconds,
    sourceFormat: speech.format,
    sourceSha256: sha256(speech.audio),
    elapsedSeconds: Math.round(speech.elapsedSeconds * 100) / 100,
    estimatedCost: { amount: 0, currency: "USD" },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    audioPath,
    receiptPath,
    ...(speech.cleanedReference ? { cleanedReferencePath: join(narrationDir, cleanedName) } : {}),
    durationSeconds,
    elapsedSeconds: speech.elapsedSeconds,
    method,
    receipt,
  };
}
