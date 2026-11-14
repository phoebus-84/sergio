// ---------------------------------------------------------------------------
// pva_synthesize_speech with provider "comfyui-qwen"
// ---------------------------------------------------------------------------
// The real tool against a stubbed `fetch` standing in for a ComfyUI server:
// nothing leaves the machine. The server's FLAC is a real one, made here with
// FFmpeg, because the tool converts it to the take's WAV.
// ---------------------------------------------------------------------------

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMFYUI_PROVIDER, comfyUiSpeechStatus } from "../src/comfyui-speech.js";

const REF = { channel: "sample-channel", series: "sample-series", episode: "ep" };
const URL_BASE = "http://comfy.test:8188";
const TEXT = "Good morning, and welcome back to the studio.";

type ToolMap = Map<string, { description: string; parameters: unknown; execute: (...a: unknown[]) => Promise<any> }>;
let root: string;
let dir: string;
let flac: Buffer;
let queued: Record<string, { class_type: string; inputs: Record<string, unknown> }>[];
let uploads: { name: string; subfolder: string; bytes: Buffer }[];
let paths: string[];
let missing: Set<string>;
const saved: Record<string, string | undefined> = {};
const ENV = ["AVG_LIBRARY_ROOT", "AVG_COMFYUI_URL", "AVG_COMFYUI_CONFIG", "AVG_TTS_WORKER_URL", "ELEVENLABS_API_KEY"];

beforeAll(async () => {
  const work = mkdtempSync(join(tmpdir(), "pva-comfy-flac-"));
  const out = join(work, "two-seconds.flac");
  const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=24000:duration=2", "-ac", "1", out], { windowsHide: true });
  if (made.status !== 0) throw new Error("these tests need ffmpeg on PATH");
  flac = readFileSync(out);
  rmSync(work, { recursive: true, force: true });
  // The first import of the tools is slow on a cold machine: paid here, not by the first test's 5 s.
  await import("../src/capability-tools.js");
}, 60_000);

async function tools(): Promise<ToolMap> {
  const { registerCapabilityTools } = await import("../src/capability-tools.js");
  const { registerAudioTools } = await import("../src/audio-tools.js");
  const map: ToolMap = new Map();
  const pi = { registerTool: (t: { name: string }) => map.set(t.name, t as never) } as never;
  registerCapabilityTools(pi);
  registerAudioTools(pi);
  return map;
}
const call = async (name: string, params: Record<string, unknown>) =>
  (await tools()).get(name)!.execute("call-1", { ...REF, ...params }, undefined, undefined, undefined);
const speak = (params: Record<string, unknown> = {}) =>
  call("pva_synthesize_speech", { sceneId: "line-1", text: TEXT, provider: COMFYUI_PROVIDER, ...params });
const narration = (file: string) => join(dir, "artifacts", "narration", file);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pva-comfy-"));
  dir = join(root, REF.channel, "series", REF.series, "episodes", REF.episode);
  mkdirSync(join(dir, "journal"), { recursive: true });
  for (const name of ENV) saved[name] = process.env[name];
  process.env.AVG_LIBRARY_ROOT = root;
  process.env.AVG_COMFYUI_URL = URL_BASE;
  delete process.env.AVG_COMFYUI_CONFIG;
  // No worker anywhere near: these tests must never reach one.
  process.env.AVG_TTS_WORKER_URL = "http://127.0.0.1:9";
  queued = [];
  uploads = [];
  paths = [];
  missing = new Set();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== URL_BASE) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const path = url.pathname;
    paths.push(path);
    if (path === "/system_stats") return Response.json({ system: { comfyui_version: "9.9.9" }, devices: [{ name: "cuda:0 Test GPU" }] });
    if (path.startsWith("/object_info/")) {
      const cls = path.slice("/object_info/".length);
      if (missing.has(cls)) return Response.json({});
      if (cls === "FB_Qwen3TTSLoadSpeaker") return Response.json({ [cls]: { input: { required: { filename: [["Anna.wav"]] } } } });
      if (cls === "FB_Qwen3TTSCustomVoice") return Response.json({ [cls]: { input: { required: { speaker: [["Ryan", "Serena"]] } } } });
      return Response.json({ [cls]: { input: { required: {} } } });
    }
    if (path === "/upload/image") {
      const form = init!.body as FormData;
      const file = form.get("image") as File;
      const subfolder = String(form.get("subfolder") ?? "");
      uploads.push({ name: file.name, subfolder, bytes: Buffer.from(await file.arrayBuffer()) });
      return Response.json({ name: file.name, subfolder, type: "input" });
    }
    if (path === "/prompt") {
      queued.push((JSON.parse(String(init!.body)) as { prompt: typeof queued[number] }).prompt);
      return Response.json({ prompt_id: `p${queued.length}` });
    }
    if (path.startsWith("/history/")) {
      const id = path.slice("/history/".length);
      const outputs: Record<string, unknown> = {};
      for (const [nodeId, node] of Object.entries(queued[Number(id.slice(1)) - 1]!)) {
        if (node.class_type !== "SaveAudio") continue;
        const prefix = String(node.inputs.filename_prefix);
        const cut = prefix.lastIndexOf("/");
        outputs[nodeId] = { audio: [{ filename: `${prefix.slice(cut + 1)}_00001_.flac`, subfolder: prefix.slice(0, cut), type: "output" }] };
      }
      return Response.json({ [id]: { status: { status_str: "success", completed: true, messages: [] }, outputs } });
    }
    if (path === "/view") return new Response(flac);
    return Response.json({}, { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe(`pva_synthesize_speech with provider ${COMFYUI_PROVIDER}`, () => {
  it("speaks with a preset speaker and writes the WAV and its synthesis record", async () => {
    const result = await speak({ voice: "serena", language: "italian", seed: 7, instruct: "calm", temperature: 0.8 });
    expect(result.isError).toBeFalsy();
    expect(queued).toHaveLength(1);
    expect(queued[0]!["1"]!.class_type).toBe("FB_Qwen3TTSCustomVoice");
    expect(queued[0]!["1"]!.inputs).toMatchObject({ text: TEXT, speaker: "Serena", language: "Italian", seed: 7, instruct: "calm", temperature: 0.8, repetition_penalty: 1.05, model_choice: "1.7B", unload_model_after_generate: true });
    const wav = readFileSync(narration("line-1.wav"));
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    const receipt = JSON.parse(readFileSync(narration("line-1.synthesis.json"), "utf-8"));
    expect(receipt).toMatchObject({
      provider: COMFYUI_PROVIDER, method: "preset-speaker", workflow: "speaker", promptId: "p1", model: "qwen3-tts-1.7B", requestedVoice: "serena",
      language: "italian", seed: 7, instruct: "calm", sampling: { temperature: 0.8 }, text: TEXT, wav: "artifacts/narration/line-1.wav",
      wavSha256: sha(wav), sourceFormat: "flac", sourceSha256: sha(flac), estimatedCost: { amount: 0, currency: "USD" },
    });
    expect(receipt.durationSeconds).toBeCloseTo(2, 2);
    expect(receipt.words).toBeUndefined();
    expect(result.details.durationSec).toBeCloseTo(2, 2);
    expect(result.content[0].text).toContain("$0");
    // the server's address is configuration: it is in no file the tool wrote
    expect(JSON.stringify(receipt)).not.toContain("comfy.test");
  });

  it("reads the server and the nodes' settings from the library's .render/comfyui.json", async () => {
    delete process.env.AVG_COMFYUI_URL;
    mkdirSync(join(root, ".render"), { recursive: true });
    writeFileSync(join(root, ".render", "comfyui.json"), JSON.stringify({ url: URL_BASE, device: "cuda", attention: "sdpa", unloadModelAfterGenerate: false, outputPrefix: "takes" }));
    const result = await speak({ voice: "Ryan" });
    expect(result.isError).toBeFalsy();
    expect(queued[0]!["1"]!.inputs).toMatchObject({ device: "cuda", attention: "sdpa", unload_model_after_generate: false });
    expect(String(queued[0]!["2"]!.inputs.filename_prefix)).toMatch(/^takes\//);
  });

  it("speaks with a voice saved on the server", async () => {
    const result = await speak({ voice: "saved:anna" });
    expect(result.isError).toBeFalsy();
    expect(queued[0]!["1"]).toEqual({ class_type: "FB_Qwen3TTSLoadSpeaker", inputs: { filename: "Anna.wav" } });
    expect(JSON.parse(readFileSync(narration("line-1.synthesis.json"), "utf-8"))).toMatchObject({ method: "saved-voice", requestedVoice: "saved:anna" });
    expect((await speak({ voice: "saved:nobody" })).content[0].text).toContain('no saved voice "nobody"; it has Anna');
  });

  it("clones a recording of the workspace, uploaded under its content's hash", async () => {
    const reference = Buffer.from("a recording of someone who consented");
    mkdirSync(join(dir, "assets", "voices"), { recursive: true });
    writeFileSync(join(dir, "assets", "voices", "Their Name.wav"), reference);
    const result = await speak({ referenceAudioPath: "assets/voices/Their Name.wav", referenceText: "What they say.", seed: 3 });
    expect(result.isError).toBeFalsy();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ name: `${sha(reference).slice(0, 32)}.wav`, subfolder: "studio-speech" });
    expect(uploads[0]!.bytes).toEqual(reference);
    expect(queued[0]!["2"]!.inputs).toMatchObject({ target_text: TEXT, ref_text: "What they say.", x_vector_only: false, seed: 3 });
    expect(JSON.stringify(queued[0])).not.toContain("Their Name");
    const receipt = JSON.parse(readFileSync(narration("line-1.synthesis.json"), "utf-8"));
    expect(receipt).toMatchObject({ method: "voice-clone", reference: { path: "assets/voices/Their Name.wav", audioSha256: sha(reference), textSha256: sha("What they say.") } });
    expect(receipt.requestedVoice).toBeUndefined();
  });

  it("cleans the reference, then clones it, and keeps the cleaned voice to listen to", async () => {
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "noisy.mp3"), Buffer.from("speech over music"));
    const result = await speak({ referenceAudioPath: "assets/noisy.mp3", referenceText: "What they say.", cleanReference: true, referenceStart: 4, referenceDuration: 11.5, saveVoiceAs: "New_Voice" });
    expect(result.isError).toBeFalsy();
    const g = queued[0]!;
    expect(Object.values(g).map((n) => n.class_type)).toEqual(["LoadAudio", "TrimAudioDuration", "AudioSeparation", "SaveAudio", "FB_Qwen3TTSVoiceClonePrompt", "FB_Qwen3TTSSaveVoice", "FB_Qwen3TTSVoiceClone", "SaveAudio"]);
    expect(g["2"]!.inputs).toMatchObject({ start_index: 4, duration: 11.5 });
    expect(g["6"]!.inputs.filename).toBe("New_Voice");
    expect(readFileSync(narration("line-1.cleaned-reference.flac"))).toEqual(flac);
    expect(JSON.parse(readFileSync(narration("line-1.synthesis.json"), "utf-8")).reference).toMatchObject({
      cleaned: true, startSeconds: 4, durationSeconds: 11.5, savedAs: "New_Voice",
      cleanedReference: "artifacts/narration/line-1.cleaned-reference.flac", cleanedReferenceSha256: sha(flac),
    });
    expect(result.details.cleanedReferencePath).toBe(narration("line-1.cleaned-reference.flac"));
  });

  it("refuses what does not fit together before the server is asked", async () => {
    const said = async (params: Record<string, unknown>) => {
      const r = await speak(params);
      expect(r.isError).toBe(true);
      return r.content[0].text as string;
    };
    expect(await said({})).toContain("needs voice");
    expect(await said({ voice: "clone:0b0e7c3a-1111-2222-3333-444455556666" })).toContain("enrolled in the local voice worker");
    expect(await said({ voice: "Ryan", referenceText: "x" })).toContain("referenceText needs referenceAudioPath");
    expect(await said({ voice: "Ryan", voiceId: "abc" })).toContain('voiceId is for provider "elevenlabs"');
    expect(await said({ referenceAudioPath: "assets/none.wav" })).toContain("there is no assets/none.wav");
    expect(await said({ referenceAudioPath: "../../../outside.wav" })).not.toContain("✅");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "ref.wav"), Buffer.from("x"));
    expect(await said({ referenceAudioPath: "assets/ref.wav", voice: "Ryan" })).toContain("not both");
    expect(await said({ referenceAudioPath: "assets/ref.wav", referenceStart: 2 })).toContain("referenceStart belongs to cleanReference");
    expect(await said({ referenceAudioPath: "assets/ref.wav", instruct: "angry" })).toContain("takes no instruct");
    expect(paths).toEqual([]);
    expect(existsSync(narration("line-1.wav"))).toBe(false);
  });

  it("keeps its parameters away from the other providers, and is never chosen for them", async () => {
    const local = await call("pva_synthesize_speech", { sceneId: "line-1", text: TEXT, referenceAudioPath: "assets/ref.wav" });
    expect(local.isError).toBe(true);
    expect(local.content[0].text).toContain(`referenceAudioPath is for provider "${COMFYUI_PROVIDER}", and this call speaks with qwen-local`);
    // the default provider stays the local worker: with none running the call fails, it does not move to ComfyUI
    const fallback = await call("pva_synthesize_speech", { sceneId: "line-1", text: TEXT });
    expect(fallback.isError).toBe(true);
    expect(queued).toHaveLength(0);
  });

  it("says where the address comes from when none is configured, and that a tunnel may be closed when nothing answers", async () => {
    delete process.env.AVG_COMFYUI_URL;
    expect((await speak({ voice: "Ryan" })).content[0].text).toContain("AVG_COMFYUI_URL is not set");
    process.env.AVG_COMFYUI_URL = "http://127.0.0.1:9";
    const down = await speak({ voice: "Ryan" });
    expect(down.isError).toBe(true);
    expect(down.content[0].text).toContain("no answer from ComfyUI at http://127.0.0.1:9");
    expect(down.content[0].text).toContain("tunnel");
  });
});

describe("the ComfyUI server in pva_capability_status and pva_voices", () => {
  it("is available when it answers, with its workflows and saved voices", async () => {
    const status = await comfyUiSpeechStatus(root);
    expect(status.available).toBe(true);
    expect(status.detail).toContain(`ComfyUI 9.9.9 at ${URL_BASE} (cuda:0 Test GPU)`);
    expect(status.detail).toContain("workflows speaker, clone, saved-voice, clean-clone");
    expect(status.detail).toContain("saved voices saved:Anna");
  });

  it("names the nodes a server lacks, and is unavailable without the Qwen3-TTS ones", async () => {
    missing.add("AudioSeparation");
    const partial = await comfyUiSpeechStatus(root);
    expect(partial.available).toBe(true);
    expect(partial.detail).toContain("workflows speaker, clone, saved-voice; missing nodes AudioSeparation");
    for (const cls of ["FB_Qwen3TTSCustomVoice", "FB_Qwen3TTSVoiceClone"]) missing.add(cls);
    expect((await comfyUiSpeechStatus(root)).available).toBe(false);
  });

  it("is unavailable when not configured or not answering", async () => {
    expect(await comfyUiSpeechStatus(root, {})).toEqual({ available: false, detail: "AVG_COMFYUI_URL is not set and the library's .render/comfyui.json names no url" });
    const down = await comfyUiSpeechStatus(root, { AVG_COMFYUI_URL: "http://127.0.0.1:9" });
    expect(down.available).toBe(false);
    expect(down.detail).toContain("no answer from ComfyUI");
  });

  it("lists the server's voices beside the worker's", async () => {
    const result = await call("pva_voices", {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("saved voices: saved:Anna");
    expect(result.details.comfyUi).toEqual({ speakers: ["Ryan", "Serena"], savedVoices: ["Anna"] });
  });
});

describe("pva_clean_voice", () => {
  it("keeps the separated voice as a new WAV under assets/, with its record", async () => {
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "noisy.mp3"), Buffer.from("speech over music"));
    const result = await call("pva_clean_voice", { inputPath: "assets/noisy.mp3", outputPath: "assets/sounds/voice.wav", duration: 8 });
    expect(result.isError).toBeFalsy();
    expect(Object.values(queued[0]!).map((n) => n.class_type)).toEqual(["LoadAudio", "TrimAudioDuration", "AudioSeparation", "SaveAudio"]);
    const wav = readFileSync(join(dir, "assets", "sounds", "voice.wav"));
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    const record = JSON.parse(readFileSync(join(dir, "assets", "sounds", "voice.wav.clean.json"), "utf-8"));
    expect(record).toMatchObject({ provider: COMFYUI_PROVIDER, operation: "clean-voice", workflow: "clean", input: { path: "assets/noisy.mp3" }, cut: { startSeconds: 0, durationSeconds: 8 }, output: { path: "assets/sounds/voice.wav", sha256: sha(wav) } });
    expect((await call("pva_clean_voice", { inputPath: "assets/noisy.mp3", outputPath: "assets/sounds/voice.wav" })).content[0].text).toContain("already exists");
    expect((await call("pva_clean_voice", { inputPath: "assets/noisy.mp3", outputPath: "voice.wav" })).content[0].text).toContain("under assets/");
  });
});
