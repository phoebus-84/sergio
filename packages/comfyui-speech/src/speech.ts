// Speech from the Qwen3-TTS nodes of a ComfyUI server (ComfyUI-Qwen-TTS,
// classes FB_Qwen3TTS*), one sentence per graph:
//
//   speakWithSpeaker      a CustomVoice preset speaker, with an optional style instruction
//   speakWithClonedVoice  the voice of a reference recording, with its transcript when known
//   speakWithSavedVoice   a voice the server saved earlier under a name
//   cleanAndClone         cut a reference, separate its voice from music and noise
//                         (audio-separation-nodes-comfyui), learn it, optionally save
//                         it under a name, and speak with it
//
// Each fills one template of ../workflows/, queues it, waits, and downloads
// what SaveAudio wrote: FLAC, as the node writes it. No fallback from one
// operation to another, and none to another server.

import { createHash, randomUUID } from "node:crypto";
import type { ComfyUiClient, ComfyUiFile, ComfyUiPrompt } from "@av/comfyui";
import { DEFAULT_INPUT_SUBFOLDER, DEFAULT_NODE_SETTINGS, DEFAULT_OUTPUT_PREFIX, DEFAULT_TIMEOUT_SECONDS, type NodeSettings } from "./config.js";
import { ComfyUiError } from "@av/comfyui";
import { flacInfo } from "./flac.js";
import { fillWorkflow, loadWorkflow, nodeClassesOf, WORKFLOW_NAMES, type WorkflowName, type WorkflowValue } from "./workflows.js";

/** The CustomVoice node's speakers, as it spells them. */
export const QWEN_NODE_SPEAKERS = ["Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian"] as const;
/** The nodes' languages, as they spell them. */
export const QWEN_NODE_LANGUAGES = ["Auto", "Chinese", "English", "Japanese", "Korean", "French", "German", "Spanish", "Portuguese", "Russian", "Italian"] as const;
/** The nodes' own sampling defaults, sent when the caller names none. */
export const DEFAULT_SAMPLING = { temperature: 0.9, repetitionPenalty: 1.05 } as const;
/** How much of a reference cleanAndClone learns from when the caller does not say: the nodes work best on 5–15 s of one voice. */
export const DEFAULT_REFERENCE_SECONDS = 15;

const REFERENCE_EXTENSIONS = new Set(["wav", "flac", "mp3", "ogg", "opus", "m4a", "aac", "mp4", "mov", "mkv", "webm"]);
const SAVED_VOICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SEED = 2 ** 31 - 1;

export interface SpeechOptions {
  client: ComfyUiClient;
  /** The sentence to say. */
  text: string;
  /** One of QWEN_NODE_LANGUAGES, in any case. Default Auto. */
  language?: string;
  /** The same seed, text and voice ask for the same take again. Default: a random one, returned. */
  seed?: number;
  /** 0.1–2. Default: the node's, 0.9. */
  temperature?: number;
  /** 1–2. Default: the node's, 1.05. */
  repetitionPenalty?: number;
  /** Over DEFAULT_NODE_SETTINGS. */
  settings?: Partial<NodeSettings>;
  /** Folder under the server's output/ the audio is saved in. */
  outputPrefix?: string;
  /** How long the graph may take, queue time included. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Tests: what names this request's files instead of a random id. */
  requestId?: string;
}

/** A recording to clone: bytes to upload, or the name of a file already in the server's input folder. */
export type Reference =
  | { bytes: Uint8Array; filename: string }
  | { inputName: string };

export interface ReferenceOptions {
  reference: Reference;
  /**
   * Exactly what the reference says. With it the model continues the
   * reference, which is much closer to the voice; without it only the
   * timbre is taken (x_vector_only).
   */
  referenceText?: string;
  /** Folder under the server's input/ an uploaded reference goes in. */
  inputSubfolder?: string;
}

export interface SavedAudio {
  /** The file as the server saved it. */
  audio: Buffer;
  format: "flac";
  /** Where it is on the server. */
  file: ComfyUiFile;
  /** From the FLAC header; null when the header cannot be read. */
  durationSeconds: number | null;
  sampleRate: number | null;
}

export interface SpeechResult extends SavedAudio {
  workflow: WorkflowName;
  promptId: string;
  /** The graph as queued. */
  prompt: ComfyUiPrompt;
  seed: number;
  /** From queueing to the audio in hand. */
  elapsedSeconds: number;
  /** For a reference that was uploaded or named: the name LoadAudio read. */
  referenceInput?: string;
  /** cleanAndClone: the separated voice the model learned from. */
  cleanedReference?: SavedAudio;
}

interface Common { values: Record<string, WorkflowValue>; seed: number; id: string; timeoutMs: number }

function common(o: SpeechOptions): Common {
  if (o.text.trim() === "") throw new ComfyUiError("bad-request", "the text is empty");
  const language = QWEN_NODE_LANGUAGES.find((l) => l.toLowerCase() === (o.language ?? "auto").toLowerCase());
  if (!language) throw new ComfyUiError("bad-request", `the Qwen3-TTS nodes do not speak "${o.language}"; one of ${QWEN_NODE_LANGUAGES.join(", ")}`);
  const temperature = o.temperature ?? DEFAULT_SAMPLING.temperature;
  if (!(temperature >= 0.1 && temperature <= 2)) throw new ComfyUiError("bad-request", `temperature ${temperature} is outside [0.1, 2]`);
  const repetitionPenalty = o.repetitionPenalty ?? DEFAULT_SAMPLING.repetitionPenalty;
  if (!(repetitionPenalty >= 1 && repetitionPenalty <= 2)) throw new ComfyUiError("bad-request", `repetitionPenalty ${repetitionPenalty} is outside [1, 2]`);
  if (o.seed !== undefined && !(Number.isInteger(o.seed) && o.seed >= 0)) throw new ComfyUiError("bad-request", `seed ${o.seed} is not a non-negative integer`);
  const seed = o.seed ?? Math.floor(Math.random() * MAX_SEED);
  const settings = { ...DEFAULT_NODE_SETTINGS, ...o.settings };
  const prefix = (o.outputPrefix ?? DEFAULT_OUTPUT_PREFIX).replace(/^\/+|\/+$/g, "");
  if (prefix === "" || prefix.includes("..")) throw new ComfyUiError("bad-request", `"${o.outputPrefix}" is not a folder under the server's output`);
  // Unique per request: SaveAudio always writes, even when ComfyUI's cache already holds the sentence.
  const id = o.requestId ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  return {
    seed,
    id,
    timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000,
    values: {
      text: o.text,
      language,
      seed,
      temperature,
      repetitionPenalty,
      model: settings.model,
      device: settings.device,
      precision: settings.precision,
      attention: settings.attention,
      unloadModel: settings.unloadModelAfterGenerate,
      outputPrefix: `${prefix}/${id}`,
    },
  };
}

/** The first audio file an output node saved. */
function savedFile(outputs: Record<string, Record<string, unknown>>, nodeId: string, what: string): ComfyUiFile {
  const audio = outputs[nodeId]?.audio;
  const first = Array.isArray(audio) ? audio[0] as Partial<ComfyUiFile> | undefined : undefined;
  if (!first || typeof first.filename !== "string") throw new ComfyUiError("no-output", `the graph finished without ${what} (node ${nodeId} saved nothing)`);
  return { filename: first.filename, subfolder: typeof first.subfolder === "string" ? first.subfolder : "", type: typeof first.type === "string" ? first.type : "output" };
}

async function fetchSaved(client: ComfyUiClient, file: ComfyUiFile, signal: AbortSignal | undefined): Promise<SavedAudio> {
  const audio = await client.download(file, signal);
  if (audio.length === 0) throw new ComfyUiError("no-output", `${file.filename} is empty`);
  const info = flacInfo(audio);
  return { audio, format: "flac", file, durationSeconds: info ? info.durationSeconds : null, sampleRate: info ? info.sampleRate : null };
}

/** Queue a graph and wait for it; what its output nodes saved. */
async function queueAndWait(
  client: ComfyUiClient, prompt: ComfyUiPrompt, timeoutMs: number, signal: AbortSignal | undefined,
): Promise<{ promptId: string; outputs: Record<string, Record<string, unknown>> }> {
  const promptId = await client.queuePrompt(prompt, signal);
  try {
    const { outputs } = await client.waitForPrompt(promptId, { timeoutMs, ...(signal ? { signal } : {}) });
    return { promptId, outputs };
  } catch (e) {
    // Given up on: take it out of the queue if it has not started. A graph
    // already running is left to finish — interrupting would stop whatever
    // the server is running, which may be someone else's.
    if (e instanceof ComfyUiError && (e.code === "aborted" || e.code === "timeout")) await client.dequeue(promptId).catch(() => undefined);
    throw e;
  }
}

async function run(
  o: SpeechOptions, workflow: WorkflowName, c: Common, extra: Record<string, WorkflowValue | undefined>,
): Promise<SpeechResult> {
  const template = loadWorkflow(workflow);
  const prompt = fillWorkflow(template, { ...c.values, ...extra });
  const started = Date.now();
  const { promptId, outputs } = await queueAndWait(o.client, prompt, c.timeoutMs, o.signal);
  const speech = await fetchSaved(o.client, savedFile(outputs, template.outputs.speech!, "the speech"), o.signal);
  const cleanedNode = template.outputs.cleanedReference;
  const cleanedReference = cleanedNode ? await fetchSaved(o.client, savedFile(outputs, cleanedNode, "the cleaned reference"), o.signal) : undefined;
  return {
    ...speech,
    workflow,
    promptId,
    prompt,
    seed: c.seed,
    elapsedSeconds: (Date.now() - started) / 1000,
    ...(cleanedReference ? { cleanedReference } : {}),
  };
}

/** The name LoadAudio reads the reference by: uploaded under its content's hash, or as the caller named it. */
async function referenceInput(o: { client: ComfyUiClient; reference: Reference; inputSubfolder?: string; signal?: AbortSignal }): Promise<string> {
  const ref = o.reference;
  if ("inputName" in ref) {
    if (ref.inputName.trim() === "" || ref.inputName.includes("..")) throw new ComfyUiError("bad-request", `"${ref.inputName}" is not a file of the server's input folder`);
    return ref.inputName;
  }
  if (ref.bytes.length === 0) throw new ComfyUiError("bad-request", "the reference is empty");
  const extension = /\.([A-Za-z0-9]+)$/.exec(ref.filename)?.[1]?.toLowerCase() ?? "";
  if (!REFERENCE_EXTENSIONS.has(extension)) throw new ComfyUiError("bad-request", `${ref.filename || "the reference"} is not an audio or video file LoadAudio reads (${[...REFERENCE_EXTENSIONS].join(", ")})`);
  // Named by content: the same recording is one file on the server however often it is used, and no local name leaves this machine.
  const name = `${createHash("sha256").update(ref.bytes).digest("hex").slice(0, 32)}.${extension}`;
  return o.client.uploadInput({ bytes: ref.bytes, filename: name, subfolder: o.inputSubfolder ?? DEFAULT_INPUT_SUBFOLDER }, o.signal);
}

const cloneValues = (referenceText: string | undefined) => {
  const text = referenceText?.trim() ?? "";
  return { referenceText: text, timbreOnly: text === "" };
};

export async function speakWithSpeaker(o: SpeechOptions & { speaker: string; instruct?: string }): Promise<SpeechResult> {
  const c = common(o);
  const speaker = QWEN_NODE_SPEAKERS.find((s) => s.toLowerCase() === o.speaker.toLowerCase());
  if (!speaker) throw new ComfyUiError("bad-request", `"${o.speaker}" is not a Qwen3-TTS speaker; one of ${QWEN_NODE_SPEAKERS.join(", ")}`);
  return run(o, "speaker", c, { speaker, instruct: o.instruct ?? "" });
}

export async function speakWithClonedVoice(o: SpeechOptions & ReferenceOptions): Promise<SpeechResult> {
  const c = common(o);
  const input = await referenceInput(o);
  return { ...await run(o, "clone", c, { referenceAudio: input, ...cloneValues(o.referenceText) }), referenceInput: input };
}

/** The saved voices a server lists, without the `.wav` its node shows them with. */
export function savedVoicesOf(loadSpeakerInfo: Record<string, unknown> | null): string[] {
  const spec = ((loadSpeakerInfo?.input as { required?: Record<string, unknown> } | undefined)?.required?.filename) as unknown[] | undefined;
  if (!Array.isArray(spec)) return [];
  // older ComfyUI: [[...options], {}]; newer: ["COMBO", { options: [...] }]
  const options = Array.isArray(spec[0]) ? spec[0] : (spec[1] as { options?: unknown } | undefined)?.options;
  return Array.isArray(options) ? options.filter((x): x is string => typeof x === "string") : [];
}

export async function speakWithSavedVoice(o: SpeechOptions & { voice: string }): Promise<SpeechResult> {
  const c = common(o);
  const files = savedVoicesOf(await o.client.nodeInfo("FB_Qwen3TTSLoadSpeaker", o.signal));
  const wanted = o.voice.replace(/\.wav$/i, "").toLowerCase();
  const file = files.find((f) => f.replace(/\.wav$/i, "").toLowerCase() === wanted);
  if (!file) {
    throw new ComfyUiError("bad-request", `the server has no saved voice "${o.voice}"${files.length > 0 ? `; it has ${files.map((f) => f.replace(/\.wav$/i, "")).join(", ")}` : "; it has none"}`);
  }
  return run(o, "saved-voice", c, { savedVoice: file });
}

export async function cleanAndClone(o: SpeechOptions & ReferenceOptions & {
  /** Where the part to learn from starts, in seconds. Default 0. */
  referenceStart?: number;
  /** How long it is, in seconds. Default DEFAULT_REFERENCE_SECONDS. */
  referenceDuration?: number;
  /** Also save the learned voice on the server under this name, for speakWithSavedVoice. */
  saveVoiceAs?: string;
}): Promise<SpeechResult> {
  const c = common(o);
  const referenceStart = o.referenceStart ?? 0;
  const referenceDuration = o.referenceDuration ?? DEFAULT_REFERENCE_SECONDS;
  if (!Number.isFinite(referenceStart)) throw new ComfyUiError("bad-request", `referenceStart ${referenceStart} is not a number of seconds`);
  if (!(referenceDuration > 0 && Number.isFinite(referenceDuration))) throw new ComfyUiError("bad-request", `referenceDuration ${referenceDuration} is not a positive number of seconds`);
  if (o.saveVoiceAs !== undefined && !SAVED_VOICE_NAME.test(o.saveVoiceAs)) throw new ComfyUiError("bad-request", `"${o.saveVoiceAs}" is not a voice name: letters, digits, _ and -`);
  const input = await referenceInput(o);
  const result = await run(o, "clean-clone", c, {
    referenceAudio: input,
    ...cloneValues(o.referenceText),
    // FLOAT inputs: sent as given, ComfyUI reads 0 and 0.0 alike
    referenceStart,
    referenceDuration,
    cleanedPrefix: `${String(c.values.outputPrefix)}-cleaned-reference`,
    saveVoiceAs: o.saveVoiceAs,
  });
  return { ...result, referenceInput: input };
}

export interface CleanVoiceOptions {
  client: ComfyUiClient;
  /** The recording to clean: bytes to upload, or a file already in the server's input folder. */
  input: Reference;
  /** Cut before separating: where the part starts, in seconds (default 0). */
  start?: number;
  /** Cut before separating: how long the part is, in seconds (default: to the end). */
  duration?: number;
  /** Folder under the server's output/ the voice is saved in. */
  outputPrefix?: string;
  /** Folder under the server's input/ an uploaded recording goes in. */
  inputSubfolder?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Tests: what names this request's files instead of a random id. */
  requestId?: string;
}

export interface CleanVoiceResult extends SavedAudio {
  workflow: "clean";
  promptId: string;
  prompt: ComfyUiPrompt;
  /** The name LoadAudio read. */
  input: string;
  elapsedSeconds: number;
}

/** Longer than any recording: the trim node stops at the end of the audio. */
const TO_THE_END = 86_400;

/**
 * The voice of a recording, without its music and noise: the clean-clone
 * workflow's cleaning half (an optional cut, AudioSeparation's Vocals), with
 * nothing learned or said.
 */
export async function cleanVoice(o: CleanVoiceOptions): Promise<CleanVoiceResult> {
  const trim = o.start !== undefined || o.duration !== undefined;
  const start = o.start ?? 0;
  if (!Number.isFinite(start)) throw new ComfyUiError("bad-request", `start ${o.start} is not a number of seconds`);
  if (o.duration !== undefined && !(o.duration > 0 && Number.isFinite(o.duration))) throw new ComfyUiError("bad-request", `duration ${o.duration} is not a positive number of seconds`);
  const prefix = (o.outputPrefix ?? DEFAULT_OUTPUT_PREFIX).replace(/^\/+|\/+$/g, "");
  if (prefix === "" || prefix.includes("..")) throw new ComfyUiError("bad-request", `"${o.outputPrefix}" is not a folder under the server's output`);
  const id = o.requestId ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const input = await referenceInput({ client: o.client, reference: o.input, ...(o.inputSubfolder ? { inputSubfolder: o.inputSubfolder } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  const template = loadWorkflow("clean");
  const prompt = fillWorkflow(template, {
    inputAudio: input,
    trim,
    ...(trim ? { start, duration: o.duration ?? TO_THE_END } : {}),
    outputPrefix: `${prefix}/${id}-voice`,
  });
  const started = Date.now();
  const { promptId, outputs } = await queueAndWait(o.client, prompt, o.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000, o.signal);
  const voice = await fetchSaved(o.client, savedFile(outputs, template.outputs.voice!, "the cleaned voice"), o.signal);
  return { ...voice, workflow: "clean", promptId, prompt, input, elapsedSeconds: (Date.now() - started) / 1000 };
}

/** What a server can do for speech, read without running anything. */
export interface SpeechProbe {
  /** ComfyUI's version, when it says. */
  version: string | null;
  devices: string[];
  /** Each workflow, and whether the server has every node it needs. */
  workflows: Record<WorkflowName, { available: boolean; missingNodes: string[] }>;
  speakers: string[];
  savedVoices: string[];
}

export async function probeSpeech(client: ComfyUiClient, signal?: AbortSignal): Promise<SpeechProbe> {
  const stats = await client.systemStats(signal) as { system?: { comfyui_version?: unknown }; devices?: { name?: unknown }[] };
  const needs = Object.fromEntries(WORKFLOW_NAMES.map((name) => [name, nodeClassesOf(loadWorkflow(name).prompt)])) as Record<WorkflowName, string[]>;
  const classes = [...new Set(Object.values(needs).flat())];
  const infos = new Map<string, Record<string, unknown> | null>();
  await Promise.all(classes.map(async (c) => { infos.set(c, await client.nodeInfo(c, signal)); }));
  const workflows = Object.fromEntries(WORKFLOW_NAMES.map((name) => {
    const missingNodes = needs[name].filter((c) => !infos.get(c));
    return [name, { available: missingNodes.length === 0, missingNodes }];
  })) as SpeechProbe["workflows"];
  const speakerSpec = ((infos.get("FB_Qwen3TTSCustomVoice")?.input as { required?: Record<string, unknown> } | undefined)?.required?.speaker) as unknown[] | undefined;
  const speakerOptions = Array.isArray(speakerSpec) ? (Array.isArray(speakerSpec[0]) ? speakerSpec[0] : (speakerSpec[1] as { options?: unknown } | undefined)?.options) : undefined;
  return {
    version: typeof stats.system?.comfyui_version === "string" ? stats.system.comfyui_version : null,
    devices: (stats.devices ?? []).map((d) => d.name).filter((n): n is string => typeof n === "string"),
    workflows,
    speakers: Array.isArray(speakerOptions) ? speakerOptions.filter((x): x is string => typeof x === "string") : [],
    savedVoices: savedVoicesOf(infos.get("FB_Qwen3TTSLoadSpeaker") ?? null).map((f) => f.replace(/\.wav$/i, "")),
  };
}
