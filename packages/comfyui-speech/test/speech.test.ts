// The client and the four operations against a faked fetch standing in for a
// ComfyUI server: what is queued, how the wait reads the history, how the
// reference is uploaded and the audio downloaded. Nothing leaves the machine.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanAndClone,
  cleanVoice,
  ComfyUiError,
  createComfyUiClient,
  DEFAULT_NODE_SETTINGS,
  fillWorkflow,
  flacInfo,
  loadWorkflow,
  nodeSettingsOf,
  placeholdersOf,
  probeSpeech,
  readComfyUiConfig,
  resolveComfyUiConfig,
  speakWithClonedVoice,
  speakWithDesignedVoice,
  speakWithSavedVoice,
  speakWithSpeaker,
  WORKFLOW_NAMES,
  type ComfyUiClient,
  type ComfyUiPrompt,
} from "../src/index.js";

const BASE = "http://comfy.test:8188";

/** A FLAC file's first 42 bytes for `seconds` of 24 kHz mono 16-bit audio, and some frame bytes. */
function flac(seconds: number, sampleRate = 24_000): Buffer {
  const b = Buffer.alloc(64);
  b.write("fLaC", 0, "latin1");
  b[4] = 0x80; // last metadata block, type STREAMINFO
  b[7] = 34;
  const total = Math.round(seconds * sampleRate);
  b[18] = sampleRate >> 12;
  b[19] = (sampleRate >> 4) & 0xff;
  b[20] = ((sampleRate & 0x0f) << 4) | (0 << 1) | 0; // 1 channel, bits-per-sample high bit 0
  b[21] = (15 << 4) | 0; // 16 bits; top 4 bits of the sample count
  b.writeUInt32BE(total, 22);
  return b;
}

interface Fake {
  fetch: typeof fetch;
  calls: { method: string; path: string; body?: unknown; form?: FormData }[];
  queued: ComfyUiPrompt[];
  /** How many times the history says "not yet" before the result. */
  pendingPolls: number;
  /** When set, /prompt answers this instead of queueing. */
  refuse?: { status: number; body: unknown };
  /** When set, the graph ends with this error. */
  fail?: { node_id: string; node_type: string; exception_message: string };
  /** Node classes the server does not have. */
  missing: Set<string>;
  savedVoices: string[];
  neverFinishes: boolean;
}

function fake(): Fake {
  const f: Fake = { calls: [], queued: [], pendingPolls: 0, missing: new Set(), savedVoices: ["Anna.wav", "Old_Narrator.wav"], neverFinishes: false, fetch: undefined as unknown as typeof fetch };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  f.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const call: Fake["calls"][number] = { method, path: path + url.search };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body);
    if (init?.body instanceof FormData) call.form = init.body;
    f.calls.push(call);
    if (path === "/system_stats") return json({ system: { comfyui_version: "9.9.9" }, devices: [{ name: "cuda:0 Test GPU" }] });
    if (path.startsWith("/object_info/")) {
      const cls = decodeURIComponent(path.slice("/object_info/".length));
      if (f.missing.has(cls)) return json({});
      if (cls === "FB_Qwen3TTSLoadSpeaker") return json({ [cls]: { input: { required: { filename: [f.savedVoices] } } } });
      if (cls === "FB_Qwen3TTSCustomVoice") return json({ [cls]: { input: { required: { speaker: [["Ryan", "Serena"], { default: "Ryan" }] } } } });
      return json({ [cls]: { input: { required: {} } } });
    }
    if (path === "/prompt") {
      if (f.refuse) return json(f.refuse.body, f.refuse.status);
      f.queued.push((call.body as { prompt: ComfyUiPrompt }).prompt);
      return json({ prompt_id: `p${f.queued.length}`, number: 1, node_errors: {} });
    }
    if (path.startsWith("/history/")) {
      const id = path.slice("/history/".length);
      if (f.neverFinishes || f.pendingPolls-- > 0) return json({});
      if (f.fail) return json({ [id]: { status: { status_str: "error", completed: false, messages: [["execution_start", {}], ["execution_error", f.fail]] }, outputs: {} } });
      const prompt = f.queued[Number(id.slice(1)) - 1]!;
      const outputs: Record<string, unknown> = {};
      for (const [nodeId, node] of Object.entries(prompt)) {
        if (node.class_type !== "SaveAudio") continue;
        const prefix = String(node.inputs.filename_prefix);
        const cut = prefix.lastIndexOf("/");
        outputs[nodeId] = { audio: [{ filename: `${prefix.slice(cut + 1)}_00001_.flac`, subfolder: prefix.slice(0, cut), type: "output" }] };
      }
      return json({ [id]: { status: { status_str: "success", completed: true, messages: [] }, outputs } });
    }
    if (path === "/upload/image") {
      const form = init!.body as FormData;
      const file = form.get("image") as File;
      return json({ name: file.name, subfolder: String(form.get("subfolder") ?? ""), type: "input" });
    }
    if (path === "/view") {
      const cleaned = url.searchParams.get("filename")!.includes("cleaned-reference");
      return new Response(flac(cleaned ? 12.6 : 3.5), { status: 200 });
    }
    if (path === "/queue") return json({});
    return json({ error: "no such route" }, 404);
  }) as typeof fetch;
  return f;
}

let f: Fake;
let client: ComfyUiClient;
const waits: number[] = [];
beforeEach(() => {
  f = fake();
  waits.length = 0;
  client = createComfyUiClient({ baseUrl: `${BASE}/`, fetch: f.fetch, sleep: async (ms) => { waits.push(ms); } });
});
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as ComfyUiError);
const TEXT = "Buongiorno a tutti.";

describe("workflow templates", () => {
  it("are API-format graphs whose links point at nodes they contain", () => {
    for (const name of WORKFLOW_NAMES) {
      const t = loadWorkflow(name);
      for (const node of Object.values(t.prompt)) {
        expect(typeof node.class_type).toBe("string");
        for (const value of Object.values(node.inputs)) {
          if (Array.isArray(value)) expect(Object.keys(t.prompt)).toContain(value[0]);
        }
      }
      for (const id of [...Object.values(t.outputs), ...Object.values(t.optionalNodes ?? {}).flat()]) expect(t.prompt[id]).toBeDefined();
      for (const id of Object.values(t.outputs)) expect(t.prompt[id]!.class_type).toBe("SaveAudio");
    }
  });

  it("name no file, voice or machine: every variable part is a placeholder", () => {
    expect(placeholdersOf(loadWorkflow("clean-clone"))).toEqual([
      "attention", "cleanedPrefix", "device", "language", "model", "outputPrefix", "precision", "referenceAudio", "referenceDuration",
      "referenceStart", "referenceText", "repetitionPenalty", "saveVoiceAs", "seed", "temperature", "text", "timbreOnly", "unloadModel",
    ]);
  });

  it("keep a value's type, and refuse a missing or an unknown name", () => {
    const t = loadWorkflow("speaker");
    const values = { text: TEXT, speaker: "Serena", model: "1.7B", device: "cuda", precision: "bf16", language: "Italian", seed: 7, instruct: "", temperature: 0.9, repetitionPenalty: 1.05, attention: "sdpa", unloadModel: true, outputPrefix: "x/y" };
    const prompt = fillWorkflow(t, values);
    expect(prompt["1"]!.inputs).toMatchObject({ text: TEXT, seed: 7, unload_model_after_generate: true, temperature: 0.9 });
    expect(prompt["2"]!.inputs).toEqual({ audio: ["1", 0], filename_prefix: "x/y" });
    expect(() => fillWorkflow(t, { ...values, seed: undefined })).toThrow(/needs a value for seed/);
    expect(() => fillWorkflow(t, { ...values, sped: 1 })).toThrow(/no placeholder for sped/);
    // the stored template is not changed by a fill
    expect(loadWorkflow("speaker").prompt["1"]!.inputs.text).toBe("{{text}}");
  });
});

describe("speakWithSpeaker", () => {
  it("queues the CustomVoice graph, waits for the history and downloads the FLAC", async () => {
    f.pendingPolls = 2;
    const result = await speakWithSpeaker({ client, text: TEXT, speaker: "serena", language: "italian", seed: 42, instruct: "calm", requestId: "req1", settings: { device: "cuda", attention: "sdpa" } });
    expect(f.queued).toHaveLength(1);
    expect(f.queued[0]).toEqual({
      "1": {
        class_type: "FB_Qwen3TTSCustomVoice",
        inputs: {
          text: TEXT, speaker: "Serena", model_choice: "1.7B", device: "cuda", precision: "bf16", language: "Italian", seed: 42, instruct: "calm",
          temperature: 0.9, repetition_penalty: 1.05, attention: "sdpa", unload_model_after_generate: true,
        },
      },
      "2": { class_type: "SaveAudio", inputs: { audio: ["1", 0], filename_prefix: "studio-speech/req1" } },
    });
    expect(waits).toEqual([500, 500]);
    expect(f.calls.map((c) => c.path)).toEqual([
      "/prompt", "/history/p1", "/history/p1", "/history/p1",
      "/view?filename=req1_00001_.flac&subfolder=studio-speech&type=output",
    ]);
    expect(result).toMatchObject({ workflow: "speaker", promptId: "p1", seed: 42, format: "flac", durationSeconds: 3.5, sampleRate: 24_000, file: { filename: "req1_00001_.flac", subfolder: "studio-speech", type: "output" } });
    expect(result.prompt).toEqual(f.queued[0]);
    expect(result.audio.subarray(0, 4).toString("latin1")).toBe("fLaC");
  });

  it("picks a seed when none is given, and names each request's file differently", async () => {
    const a = await speakWithSpeaker({ client, text: TEXT, speaker: "Ryan" });
    const b = await speakWithSpeaker({ client, text: TEXT, speaker: "Ryan" });
    expect(Number.isInteger(a.seed)).toBe(true);
    expect(f.queued[0]!["1"]!.inputs.seed).toBe(a.seed);
    expect(f.queued[0]!["1"]!.inputs.language).toBe("Auto");
    expect(f.queued[0]!["2"]!.inputs.filename_prefix).not.toBe(f.queued[1]!["2"]!.inputs.filename_prefix);
    expect(b.promptId).toBe("p2");
  });

  it("refuses a wrong speaker, language, sampling or empty text before anything is queued", async () => {
    expect((await failure(speakWithSpeaker({ client, text: TEXT, speaker: "nobody" }))).message).toMatch(/not a Qwen3-TTS speaker/);
    expect((await failure(speakWithSpeaker({ client, text: TEXT, speaker: "Ryan", language: "klingon" }))).code).toBe("bad-request");
    expect((await failure(speakWithSpeaker({ client, text: TEXT, speaker: "Ryan", temperature: 3 }))).message).toMatch(/temperature/);
    expect((await failure(speakWithSpeaker({ client, text: TEXT, speaker: "Ryan", repetitionPenalty: 2.5 }))).message).toMatch(/repetitionPenalty/);
    expect((await failure(speakWithSpeaker({ client, text: "  ", speaker: "Ryan" }))).message).toMatch(/empty/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("a graph that does not succeed", () => {
  it("says what the server refused, node by node", async () => {
    f.refuse = { status: 400, body: { error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation", details: "" }, node_errors: { "1": { class_type: "LoadAudio", errors: [{ message: "Invalid audio file", details: "x.wav" }] } } } };
    const e = await failure(speakWithClonedVoice({ client, text: TEXT, reference: { inputName: "x.wav" } }));
    expect(e.code).toBe("bad-request");
    expect(e.message).toContain("Prompt outputs failed validation; node 1 (LoadAudio): Invalid audio file: x.wav");
  });

  it("reports the node that raised while it ran", async () => {
    f.fail = { node_id: "1", node_type: "FB_Qwen3TTSCustomVoice", exception_message: "CUDA out of memory\n" };
    const e = await failure(speakWithSpeaker({ client, text: TEXT, speaker: "Ryan" }));
    expect(e.code).toBe("failed");
    expect(e.message).toBe("graph p1 failed: node 1 (FB_Qwen3TTSCustomVoice): CUDA out of memory");
  });

  it("gives up after the time allowed and takes the graph out of the queue", async () => {
    f.neverFinishes = true;
    const e = await failure(speakWithSpeaker({ client, text: TEXT, speaker: "Ryan", timeoutMs: 0 }));
    expect(e.code).toBe("timeout");
    expect(f.calls.at(-1)).toMatchObject({ method: "POST", path: "/queue", body: { delete: ["p1"] } });
  });

  it("stops when the caller aborts", async () => {
    f.neverFinishes = true;
    const controller = new AbortController();
    const slow = createComfyUiClient({ baseUrl: BASE, fetch: f.fetch, sleep: async () => { controller.abort(); } });
    const e = await failure(speakWithSpeaker({ client: slow, text: TEXT, speaker: "Ryan", signal: controller.signal }));
    expect(e.code).toBe("aborted");
  });

  it("is unreachable when no connection is made, and names the address only", async () => {
    const down = createComfyUiClient({ baseUrl: BASE, fetch: (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }) as unknown as typeof fetch });
    const e = await failure(speakWithSpeaker({ client: down, text: TEXT, speaker: "Ryan" }));
    expect(e.code).toBe("unreachable");
    expect(e.message).toBe(`no answer from ComfyUI at ${BASE} (ECONNREFUSED)`);
  });

  it("is no-output when the graph finished without the audio", async () => {
    const empty = createComfyUiClient({ baseUrl: BASE, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/history/")) return new Response(JSON.stringify({ p1: { status: { status_str: "success", completed: true }, outputs: {} } }));
      return f.fetch(input, init);
    }) as typeof fetch });
    expect((await failure(speakWithSpeaker({ client: empty, text: TEXT, speaker: "Ryan" }))).code).toBe("no-output");
  });
});

describe("speakWithClonedVoice", () => {
  const bytes = Buffer.from("not really audio, but bytes to hash");
  const hashed = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.wav`;

  it("uploads the reference under its content's hash and continues it when the transcript is given", async () => {
    const result = await speakWithClonedVoice({ client, text: TEXT, language: "Italian", seed: 1, reference: { bytes, filename: "Someone's Voice.WAV" }, referenceText: " What the reference says. ", requestId: "r" });
    const upload = f.calls[0]!;
    expect(upload).toMatchObject({ method: "POST", path: "/upload/image" });
    expect((upload.form!.get("image") as File).name).toBe(hashed);
    expect(upload.form!.get("type")).toBe("input");
    expect(upload.form!.get("overwrite")).toBe("true");
    expect(upload.form!.get("subfolder")).toBe("studio-speech");
    expect(Buffer.from(await (upload.form!.get("image") as File).arrayBuffer())).toEqual(bytes);
    expect(f.queued[0]!["1"]).toEqual({ class_type: "LoadAudio", inputs: { audio: `studio-speech/${hashed}` } });
    expect(f.queued[0]!["2"]!.inputs).toMatchObject({ target_text: TEXT, ref_audio: ["1", 0], ref_text: "What the reference says.", x_vector_only: false, seed: 1, language: "Italian" });
    expect(result.referenceInput).toBe(`studio-speech/${hashed}`);
    expect(JSON.stringify(f.queued[0])).not.toContain("Someone");
  });

  it("takes only the timbre without a transcript, and reads a file already on the server by its name", async () => {
    await speakWithClonedVoice({ client, text: TEXT, reference: { inputName: "there.flac" } });
    expect(f.calls[0]!.path).toBe("/prompt");
    expect(f.queued[0]!["1"]!.inputs.audio).toBe("there.flac");
    expect(f.queued[0]!["2"]!.inputs).toMatchObject({ ref_text: "", x_vector_only: true });
  });

  it("refuses a reference that is empty or not audio", async () => {
    expect((await failure(speakWithClonedVoice({ client, text: TEXT, reference: { bytes: Buffer.alloc(0), filename: "a.wav" } }))).message).toMatch(/empty/);
    expect((await failure(speakWithClonedVoice({ client, text: TEXT, reference: { bytes, filename: "a.txt" } }))).message).toMatch(/not an audio or video file/);
    expect((await failure(speakWithClonedVoice({ client, text: TEXT, reference: { inputName: "../models/x.wav" } }))).code).toBe("bad-request");
    expect(f.calls).toHaveLength(0);
  });
});

describe("speakWithSavedVoice", () => {
  it("loads the voice by the file the server lists it as", async () => {
    await speakWithSavedVoice({ client, text: TEXT, voice: "anna", seed: 3 });
    expect(f.queued[0]!["1"]).toEqual({ class_type: "FB_Qwen3TTSLoadSpeaker", inputs: { filename: "Anna.wav" } });
    expect(f.queued[0]!["2"]!.inputs).toMatchObject({ voice_clone_prompt: ["1", 0], x_vector_only: false, seed: 3 });
    expect(f.queued[0]!["2"]!.inputs).not.toHaveProperty("ref_audio");
  });

  it("says which voices the server has when it lacks the one asked for", async () => {
    const e = await failure(speakWithSavedVoice({ client, text: TEXT, voice: "Zed" }));
    expect(e.message).toBe('the server has no saved voice "Zed"; it has Anna, Old_Narrator');
    expect(f.queued).toHaveLength(0);
  });
});

describe("cleanAndClone", () => {
  it("cuts, separates, learns and speaks; the cleaned reference comes back too", async () => {
    const result = await cleanAndClone({ client, text: TEXT, language: "italian", seed: 42, reference: { inputName: "noisy.wav" }, referenceText: "What it says.", referenceStart: 2.5, referenceDuration: 12.6, requestId: "r" });
    const g = f.queued[0]!;
    expect(Object.values(g).map((n) => n.class_type)).toEqual(["LoadAudio", "TrimAudioDuration", "AudioSeparation", "SaveAudio", "FB_Qwen3TTSVoiceClonePrompt", "FB_Qwen3TTSVoiceClone", "SaveAudio"]);
    expect(g["2"]!.inputs).toEqual({ audio: ["1", 0], start_index: 2.5, duration: 12.6 });
    expect(g["3"]!.inputs).toEqual({ audio: ["2", 0], chunk_fade_shape: "linear", chunk_length: 10, chunk_overlap: 0.1 });
    // the Vocals output of the separation is what is learned and what is saved to listen to
    expect(g["4"]!.inputs).toEqual({ audio: ["3", 3], filename_prefix: "studio-speech/r-cleaned-reference" });
    expect(g["5"]!.inputs).toMatchObject({ ref_audio: ["3", 3], ref_text: "What it says.", x_vector_only: false });
    expect(g["7"]!.inputs).toMatchObject({ target_text: TEXT, voice_clone_prompt: ["5", 0], seed: 42 });
    expect(g["6"]).toBeUndefined();
    expect(result.durationSeconds).toBe(3.5);
    expect(result.cleanedReference).toMatchObject({ durationSeconds: 12.6, file: { filename: "r-cleaned-reference_00001_.flac" } });
  });

  it("learns 15 s from the start unless told, and saves the voice under a name only when asked", async () => {
    await cleanAndClone({ client, text: TEXT, reference: { inputName: "noisy.wav" }, saveVoiceAs: "New_Voice" });
    const g = f.queued[0]!;
    expect(g["2"]!.inputs).toMatchObject({ start_index: 0, duration: 15 });
    expect(g["6"]).toEqual({ class_type: "FB_Qwen3TTSSaveVoice", inputs: { voice_clone_prompt: ["5", 0], filename: "New_Voice", audio: ["3", 3], ref_text: "" } });
    expect(g["5"]!.inputs.x_vector_only).toBe(true);
    expect((await failure(cleanAndClone({ client, text: TEXT, reference: { inputName: "noisy.wav" }, saveVoiceAs: "../x" }))).message).toMatch(/not a voice name/);
    expect((await failure(cleanAndClone({ client, text: TEXT, reference: { inputName: "noisy.wav" }, referenceDuration: 0 }))).message).toMatch(/referenceDuration/);
  });
});

describe("speakWithDesignedVoice", () => {
  it("speaks in a voice made from a description, on the 1.7B VoiceDesign model, without learning or saving it", async () => {
    const result = await speakWithDesignedVoice({ client, text: TEXT, language: "italian", seed: 5, voiceDescription: "  An old fisherman, low and slow, with a Genoese accent. ", requestId: "d", settings: { model: "0.6B" } });
    const g = f.queued[0]!;
    expect(Object.keys(g)).toEqual(["1", "2"]);
    expect(g["1"]).toEqual({
      class_type: "FB_Qwen3TTSVoiceDesign",
      inputs: {
        text: TEXT, instruct: "An old fisherman, low and slow, with a Genoese accent.", model_choice: "1.7B", device: "auto", precision: "bf16", language: "Italian", seed: 5,
        temperature: 0.9, repetition_penalty: 1.05, attention: "auto", unload_model_after_generate: true,
      },
    });
    expect(g["2"]!.inputs).toEqual({ audio: ["1", 0], filename_prefix: "studio-speech/d" });
    expect(result).toMatchObject({ workflow: "design", seed: 5, durationSeconds: 3.5 });
  });

  it("learns the designed voice from the sentence with the Base model and saves it under a name when asked", async () => {
    await speakWithDesignedVoice({ client, text: TEXT, voiceDescription: "A bright young voice.", saveVoiceAs: "Fisher_1", settings: { model: "0.6B" } });
    const g = f.queued[0]!;
    expect(g["3"]).toMatchObject({ class_type: "FB_Qwen3TTSVoiceClonePrompt", inputs: { ref_audio: ["1", 0], ref_text: TEXT, model_choice: "0.6B", x_vector_only: false } });
    expect(g["4"]).toEqual({ class_type: "FB_Qwen3TTSSaveVoice", inputs: { voice_clone_prompt: ["3", 0], filename: "Fisher_1", audio: ["1", 0], ref_text: TEXT } });
  });

  it("refuses an empty description or a bad name before anything is queued", async () => {
    expect((await failure(speakWithDesignedVoice({ client, text: TEXT, voiceDescription: " " }))).message).toMatch(/description is empty/);
    expect((await failure(speakWithDesignedVoice({ client, text: TEXT, voiceDescription: "x", saveVoiceAs: "a/b" }))).message).toMatch(/not a voice name/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("probeSpeech", () => {
  it("reads the version, the speakers, the saved voices and which workflows the server can run", async () => {
    f.missing.add("AudioSeparation");
    const probe = await probeSpeech(client);
    expect(probe.version).toBe("9.9.9");
    expect(probe.devices).toEqual(["cuda:0 Test GPU"]);
    expect(probe.speakers).toEqual(["Ryan", "Serena"]);
    expect(probe.savedVoices).toEqual(["Anna", "Old_Narrator"]);
    expect(probe.workflows.speaker).toEqual({ available: true, missingNodes: [] });
    expect(probe.workflows["clean-clone"]).toEqual({ available: false, missingNodes: ["AudioSeparation"] });
    expect(probe.workflows.design).toEqual({ available: true, missingNodes: [] });
    expect(f.queued).toHaveLength(0);
  });
});

describe("configuration", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "comfyui-speech-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("is empty without a file, and the URL given goes over the file's", () => {
    expect(readComfyUiConfig(join(dir, "none.json"))).toEqual({});
    const file = join(dir, "comfyui.json");
    writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:8188", device: "cuda", unloadModelAfterGenerate: false }));
    expect(resolveComfyUiConfig({ file }).url).toBe("http://127.0.0.1:8188");
    expect(resolveComfyUiConfig({ file, url: "http://127.0.0.1:9999" }).url).toBe("http://127.0.0.1:9999");
    expect(nodeSettingsOf(readComfyUiConfig(file))).toEqual({ ...DEFAULT_NODE_SETTINGS, device: "cuda", unloadModelAfterGenerate: false });
  });

  it("refuses a file that is not what it should be", () => {
    const file = join(dir, "comfyui.json");
    writeFileSync(file, "{");
    expect(() => readComfyUiConfig(file)).toThrow(/is not JSON/);
    writeFileSync(file, JSON.stringify({ url: 8188 }));
    expect(() => readComfyUiConfig(file)).toThrow(/url is not a string/);
    expect(() => createComfyUiClient({ baseUrl: "localhost:8188" })).toThrow(ComfyUiError);
  });
});

describe("cleanVoice", () => {
  it("separates the voice without a cut: the trim node is bypassed", async () => {
    const result = await cleanVoice({ client, input: { inputName: "noisy.wav" }, requestId: "r" });
    const g = f.queued[0]!;
    expect(Object.values(g).map((n) => n.class_type)).toEqual(["LoadAudio", "AudioSeparation", "SaveAudio"]);
    expect(g["3"]!.inputs).toEqual({ audio: ["1", 0], chunk_fade_shape: "linear", chunk_length: 10, chunk_overlap: 0.1 });
    expect(g["4"]!.inputs).toEqual({ audio: ["3", 3], filename_prefix: "studio-speech/r-voice" });
    expect(result).toMatchObject({ workflow: "clean", input: "noisy.wav", durationSeconds: 3.5, format: "flac" });
  });

  it("cuts first when asked, and uploads bytes under their hash", async () => {
    await cleanVoice({ client, input: { bytes: Buffer.from("rec"), filename: "x.mp3" }, start: 2 });
    const g = f.queued[0]!;
    expect(g["2"]!.inputs).toEqual({ audio: ["1", 0], start_index: 2, duration: 86_400 });
    expect(g["3"]!.inputs.audio).toEqual(["2", 0]);
    expect(f.calls[0]!.path).toBe("/upload/image");
    expect((await failure(cleanVoice({ client, input: { inputName: "a.wav" }, duration: 0 }))).message).toMatch(/duration/);
  });
});

describe("flacInfo", () => {
  it("reads the length from STREAMINFO, and is null for anything else", () => {
    expect(flacInfo(flac(3.5))).toEqual({ sampleRate: 24_000, channels: 1, bitsPerSample: 16, totalSamples: 84_000, durationSeconds: 3.5 });
    expect(flacInfo(flac(2, 44_100))!.sampleRate).toBe(44_100);
    expect(flacInfo(Buffer.from("RIFF....WAVE".padEnd(64, ".")))).toBeNull();
  });
});
