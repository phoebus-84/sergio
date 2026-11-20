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
// The server is configuration, never code: AVG_COMFYUI_URL; else the
// machines file's comfyui machines (ADR-0056), reached by their `url` or
// through a tunnel @av/machines opens on demand, with the machine's GPU lock
// held around each call; else `url` in the library's .render/comfyui.json
// (AVG_COMFYUI_CONFIG names another file), which also holds the nodes'
// settings.
//
// ComfyUI saves FLAC; the take is a WAV, so FFmpeg converts it here. Qwen
// times no words: the take is aligned afterwards like any other.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  cleanAndClone,
  cleanVoice,
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
import { machinesWith, reachService, withLock, type Machine } from "@av/machines";
import { gpuLockOf, machineDeps, MACHINES_RELATIVE, studioMachines } from "./machines.js";

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

const NOT_CONFIGURED = `${COMFYUI_URL_ENV} is not set, the library's ${MACHINES_RELATIVE.replace(/\\/g, "/")} gives no machine the comfyui role, and its ${COMFYUI_CONFIG_RELATIVE.replace(/\\/g, "/")} names no url`;

/** Where the server was found: the variable, a machine of the machines file, or comfyui.json. */
export interface ComfyUiEndpoint {
  config: ComfyUiSpeechConfig;
  url: string;
  via: "env" | "machine" | "file";
  machine?: Machine;
  tunnel?: boolean;
  /** The machines passed over first, and why. */
  skipped?: { name: string; reason: string }[];
}

/** Whether ComfyUI answers at this base URL. */
export async function comfyUiAnswers(url: string): Promise<boolean> {
  const res = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(3_000) });
  await res.body?.cancel();
  return res.ok;
}

/**
 * The server to speak through, in ADR-0056's order: AVG_COMFYUI_URL, else
 * the machines file's comfyui machines (the first that answers, a tunnel
 * opened when it listens only on its loopback), else comfyui.json's url.
 * Null when none names one. Machines that are declared but do not answer
 * are an error, not a reason to use comfyui.json.
 */
export async function comfyUiEndpoint(libraryRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<ComfyUiEndpoint | null> {
  const config = comfyUiConfig(libraryRoot, env);
  if (env[COMFYUI_URL_ENV]) return { config, url: env[COMFYUI_URL_ENV]!, via: "env" };
  const machines = studioMachines(libraryRoot, env);
  if (machinesWith(machines, "comfyui").length > 0) {
    const { pool, spawn } = machineDeps();
    const reached = await reachService(machines, "comfyui", { healthy: comfyUiAnswers, pool, ...(spawn ? { spawn } : {}) });
    return { config: { ...config, url: reached.url }, url: reached.url, via: "machine", machine: reached.machine, tunnel: reached.via === "tunnel", skipped: reached.skipped };
  }
  return config.url ? { config, url: config.url, via: "file" } : null;
}

function describe(endpoint: ComfyUiEndpoint): string {
  if (endpoint.via !== "machine") return endpoint.url;
  const settings = endpoint.machine!.roles.comfyui ?? {};
  return endpoint.tunnel
    ? `${endpoint.machine!.name} (through a tunnel to ${settings.host ?? "127.0.0.1"}:${settings.port ?? 8188}, here ${endpoint.url})`
    : `${endpoint.machine!.name} (${endpoint.url})`;
}

/** Runs one call to the server, holding its machine's GPU lock when the machines file names one. */
async function onServer<T>(endpoint: ComfyUiEndpoint, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lock = endpoint.machine ? gpuLockOf(endpoint.machine, "comfyui") : undefined;
  try {
    return await withLock(machineDeps().exec, endpoint.machine?.ssh ?? "", lock, work, signal ? { signal } : {});
  } catch (e) {
    if (e instanceof ComfyUiError && e.code === "unreachable") {
      throw new Error(endpoint.via === "machine"
        ? `${e.message}: is ComfyUI running on ${endpoint.machine!.name}?`
        : `${e.message}: is the server running${endpoint.via === "env" ? ", and the tunnel to it open" : ""}?`);
    }
    throw e;
  }
}

/** What a receipt says about the machine that spoke, when the machines file chose it. */
function serverOf(endpoint: ComfyUiEndpoint): Record<string, unknown> {
  if (endpoint.via !== "machine") return {};
  const lock = gpuLockOf(endpoint.machine!, "comfyui");
  return { server: { machine: endpoint.machine!.name, ssh: endpoint.machine!.ssh, via: endpoint.tunnel ? "tunnel" : "url", ...(lock ? { gpuLock: lock } : {}) } };
}

/** What the tool says about this provider, in its description. */
export function comfyUiSpeechTerms(): string {
  return `free, on the operator's own ComfyUI server (${COMFYUI_URL_ENV}); voice is a speaker (${QWEN_NODE_SPEAKERS.join(", ")}) or saved:<name> for a voice saved there; ` +
    "or referenceAudioPath clones the voice of a recording in this workspace (referenceText: exactly what it says — much closer with it), " +
    `and cleanReference first cuts it (referenceStart, referenceDuration, default the first ${DEFAULT_REFERENCE_SECONDS} s) and separates the voice from music and noise; cloned and saved voices require voiceConsentPath, an operator-created consent record bound to the reference hash or saved name`;
}

/** Whether the server answers and what it can do, for pva_capability_status. */
export async function comfyUiSpeechStatus(libraryRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<{ available: boolean; detail: string }> {
  let endpoint: ComfyUiEndpoint | null;
  try {
    endpoint = await comfyUiEndpoint(libraryRoot, env);
  } catch (e) {
    return { available: false, detail: e instanceof Error ? e.message : String(e) };
  }
  if (!endpoint) return { available: false, detail: NOT_CONFIGURED };
  let probe: SpeechProbe;
  try {
    probe = await probeSpeech(createComfyUiClient({ baseUrl: endpoint.url, requestTimeoutMs: 5_000 }));
  } catch (e) {
    return {
      available: false,
      detail: `${e instanceof Error ? e.message : String(e)}` +
        (endpoint.via === "machine" ? "" : `; a server that listens on another machine's loopback is reached by giving that machine the comfyui role in ${MACHINES_RELATIVE.replace(/\\/g, "/")}`),
    };
  }
  const ready = Object.entries(probe.workflows).filter(([, w]) => w.available).map(([name]) => name);
  const missing = [...new Set(Object.values(probe.workflows).flatMap((w) => w.missingNodes))];
  const skipped = endpoint.skipped?.length ? `; passed over ${endpoint.skipped.map((k) => `${k.name} (${k.reason})`).join(", ")}` : "";
  const lock = endpoint.machine ? gpuLockOf(endpoint.machine, "comfyui") : undefined;
  const what = `ComfyUI ${probe.version ?? "?"} ${endpoint.via === "machine" ? "on" : "at"} ${describe(endpoint)}${lock ? `, GPU lock ${lock}` : ""}${skipped}${probe.devices.length > 0 ? ` (${probe.devices.join(", ")})` : ""}`;
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
  const endpoint = await comfyUiEndpoint(libraryRoot);
  if (!endpoint) return null;
  const probe = await probeSpeech(createComfyUiClient({ baseUrl: endpoint.url, requestTimeoutMs: 5_000 }));
  return { speakers: probe.speakers, savedVoices: probe.savedVoices };
}

/** FLAC to 16-bit PCM WAV, at the rate and channels it has. */
async function flacToWav(flac: Buffer, canonical = false, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const work = mkdtempSync(join(tmpdir(), "pva-comfyui-speech-"));
  try {
    const input = join(work, "speech.flac");
    const output = join(work, "speech.wav");
    writeFileSync(input, flac);
    const { status, stderr } = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map_metadata", "-1", ...(canonical ? ["-ar", "24000", "-ac", "1"] : []), "-c:a", "pcm_s16le", output], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
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

/** Read RIFF chunks rather than searching for a word inside metadata or samples. */
function wavSeconds(wav: Buffer, requireSpeech = false): number {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("FFmpeg returned no PCM WAV");
  let byteRate = 0;
  let samples: Buffer | undefined;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const end = at + 8 + size;
    if (end > wav.length) throw new Error("FFmpeg returned a truncated WAV");
    if (id === "fmt " && size >= 16) {
      if (wav.readUInt16LE(at + 8) !== 1 || wav.readUInt16LE(at + 22) !== 16) throw new Error("Expected PCM16 WAV");
      if (requireSpeech && (wav.readUInt16LE(at + 10) !== 1 || wav.readUInt32LE(at + 12) !== 24000)) throw new Error("Expected mono 24 kHz speech");
      byteRate = wav.readUInt32LE(at + 16);
    }
    if (id === "data") samples = wav.subarray(at + 8, end);
    at = end + (size % 2);
  }
  if (!byteRate || !samples?.length) throw new Error("FFmpeg returned an empty WAV");
  if (requireSpeech && !samples.some((byte) => byte !== 0)) throw new Error("ComfyUI returned silent speech");
  return samples.length / byteRate;
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
  /** Operator-maintained consent record, guarded to this workspace. */
  consent?: { absolutePath: string; relativePath: string };
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

/** A clone cannot bypass consent merely by choosing a different provider. */
function cloneConsent(r: ComfyUiSpeechRequest, referenceBytes?: Buffer): Record<string, unknown> | undefined {
  const cloning = Boolean(r.reference || r.voice?.startsWith(SAVED_PREFIX));
  if (!cloning) {
    if (r.consent) throw new Error("voiceConsentPath is only for a cloned or saved voice");
    return undefined;
  }
  if (!r.consent) throw new Error("cloning needs voiceConsentPath: an operator-created consent record bound to this reference or saved voice");
  const bytes = readFileSync(r.consent.absolutePath);
  if (bytes.length > 16_384) throw new Error("voice consent record exceeds 16 KiB");
  const value: unknown = JSON.parse(bytes.toString("utf-8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("voice consent must be a JSON object");
  const c = value as Record<string, unknown>;
  if (c.confirmed !== true || typeof c.source !== "string" || !["self_recorded", "licensed", "synthetic"].includes(c.source) ||
      typeof c.statement !== "string" || c.statement.length < 10 || c.statement.length > 1000 ||
      typeof c.license_or_terms !== "string" || c.license_or_terms.length < 2 || c.license_or_terms.length > 500 ||
      typeof c.recorded_at !== "string" || !Number.isFinite(Date.parse(c.recorded_at))) {
    throw new Error("voice consent needs confirmed:true, source, statement (10–1000 chars), license_or_terms (2–500 chars), and recorded_at");
  }
  if (referenceBytes ? c.reference_audio_sha256 !== sha256(referenceBytes) : c.saved_voice !== r.voice) {
    throw new Error("voice consent does not match this reference_audio_sha256 or saved_voice");
  }
  return { path: r.consent.relativePath.replace(/\\/g, "/"), sha256: sha256(bytes), source: c.source, recordedAt: c.recorded_at,
    ...(referenceBytes ? { referenceAudioSha256: c.reference_audio_sha256 } : { savedVoice: c.saved_voice }) };
}

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

  const referenceBytes = r.reference ? readFileSync(r.reference.absolutePath) : undefined;
  const consent = cloneConsent(r, referenceBytes);
  r.signal?.throwIfAborted();
  const endpoint = await comfyUiEndpoint(r.libraryRoot);
  if (!endpoint) throw new Error(NOT_CONFIGURED);
  const config = endpoint.config;
  const client = createComfyUiClient({ baseUrl: endpoint.url });
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

  let speech!: SpeechResult;
  let method!: string;
  await onServer(endpoint, async () => {
    if (r.reference) {
      const reference = {
        // Only the extension leaves this machine: the package names the upload by its content's hash.
        reference: { bytes: referenceBytes!, filename: basename(r.reference.absolutePath) },
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
  }, r.signal);

  const wav = await flacToWav(speech.audio, true, r.signal);
  const durationSeconds = Math.round(wavSeconds(wav, true) * 1000) / 1000;
  r.signal?.throwIfAborted();
  const narrationDir = join(r.dir, "artifacts", "narration");
  const audioPath = join(narrationDir, `${r.sceneId}.wav`);
  const receiptPath = join(narrationDir, `${r.sceneId}.synthesis.json`);
  mkdirSync(narrationDir, { recursive: true });
  writeFileSync(audioPath, wav);
  // The separated voice the model learned from, kept to be listened to: a bad separation explains a bad clone.
  const cleanedName = `${r.sceneId}.cleaned-reference.flac`;
  if (speech.cleanedReference) writeFileSync(join(narrationDir, cleanedName), speech.cleanedReference.audio);

  const sampling = {
    ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
    ...(r.repetitionPenalty !== undefined ? { repetitionPenalty: r.repetitionPenalty } : {}),
  };
  const receipt = {
    provider: COMFYUI_PROVIDER,
    method,
    workflow: speech.workflow,
    promptId: speech.promptId,
    workflowSha256: sha256(JSON.stringify(speech.prompt)),
    requestedRuntime: settings,
    ...serverOf(endpoint),
    runtimeVerified: false, // The server does not report exact checkpoint hashes or resolved runtime versions.
    ...(consent ? { consent } : {}),
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

// ── Clean only: the voice of a recording, without its music and noise ───────

export interface ComfyUiCleanRequest {
  libraryRoot: string;
  /** The recording, already checked to be inside the workspace. */
  input: { absolutePath: string; relativePath: string };
  /** Where the WAV goes, already checked; relative to the workspace. */
  output: { absolutePath: string; relativePath: string };
  start?: number;
  duration?: number;
  signal?: AbortSignal;
}

export async function cleanVoiceWithComfyUi(r: ComfyUiCleanRequest): Promise<{ recordPath: string; durationSeconds: number; elapsedSeconds: number; record: Record<string, unknown> }> {
  const endpoint = await comfyUiEndpoint(r.libraryRoot);
  if (!endpoint) throw new Error(NOT_CONFIGURED);
  const config = endpoint.config;
  const inputBytes = readFileSync(r.input.absolutePath);
  const cleaned = await onServer(endpoint, () => cleanVoice({
      client: createComfyUiClient({ baseUrl: endpoint.url }),
      // Only the extension leaves this machine: the package names the upload by its content's hash.
      input: { bytes: inputBytes, filename: basename(r.input.absolutePath) },
      ...(r.start !== undefined ? { start: r.start } : {}),
      ...(r.duration !== undefined ? { duration: r.duration } : {}),
      ...(config.outputPrefix ? { outputPrefix: config.outputPrefix } : {}),
      ...(config.inputSubfolder ? { inputSubfolder: config.inputSubfolder } : {}),
      ...(config.timeoutSeconds ? { timeoutMs: config.timeoutSeconds * 1000 } : {}),
      ...(r.signal ? { signal: r.signal } : {}),
    }), r.signal);
  const wav = await flacToWav(cleaned.audio, false, r.signal);
  r.signal?.throwIfAborted();
  mkdirSync(dirname(r.output.absolutePath), { recursive: true });
  writeFileSync(r.output.absolutePath, wav);
  const durationSeconds = Math.round(wavSeconds(wav) * 1000) / 1000;
  const recordPath = `${r.output.absolutePath}.clean.json`;
  const record = {
    provider: COMFYUI_PROVIDER,
    operation: "clean-voice",
    workflow: cleaned.workflow,
    promptId: cleaned.promptId,
    separation: "AudioSeparation (Hybrid Demucs), Vocals",
    ...serverOf(endpoint),
    input: { path: r.input.relativePath.replace(/\\/g, "/"), sha256: sha256(inputBytes) },
    ...(r.start !== undefined || r.duration !== undefined ? { cut: { startSeconds: r.start ?? 0, ...(r.duration !== undefined ? { durationSeconds: r.duration } : {}) } } : {}),
    output: { path: r.output.relativePath.replace(/\\/g, "/"), sha256: sha256(wav), durationSeconds },
    sourceFormat: cleaned.format,
    sourceSha256: sha256(cleaned.audio),
    elapsedSeconds: Math.round(cleaned.elapsedSeconds * 100) / 100,
    estimatedCost: { amount: 0, currency: "USD" },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { recordPath, durationSeconds, elapsedSeconds: cleaned.elapsedSeconds, record };
}
