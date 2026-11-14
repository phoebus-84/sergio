// ---------------------------------------------------------------------------
// pva_synthesize_speech with provider "elevenlabs", and the take it makes
// ---------------------------------------------------------------------------
// The real tools against a stubbed `fetch` standing in for ElevenLabs: nothing
// leaves the machine and nothing is spent. Then the free path to a timed take:
// pva_register_take, pva_align_take with provider "synthesis" — one paid call
// in all, the synthesis.
//
// Prices, the default model and the default voice settings are read from
// @av/elevenlabs' profile; the voice id is a made-up one.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELEVENLABS_PROFILES, speechSynthesisUsd } from "@av/elevenlabs";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { parseJournal, JOURNAL_RELATIVE_PATH } from "@studio/contracts/src/journal.mjs";
import { validateWordTiming } from "@studio/contracts/src/word-timing.mjs";
import { elevenLabsStatus } from "../src/capability-status.js";
import { elevenLabsSpeechTerms } from "../src/elevenlabs-speech.js";

const REF = { channel: "sample-channel", series: "sample-series", episode: "ep" };
const VOICE = "fakeVoiceId0001";
const KEY = "sk_test_never_print_me";
const TEXT = "Good morning, and welcome back to the studio.";
const SPEECH = ELEVENLABS_PROFILES.speechSynthesis;
const SAMPLE_RATE = Number(SPEECH.outputFormat.replace("pcm_", ""));
const SECONDS = 3;

type ToolMap = Map<string, { description: string; parameters: unknown; execute: (...a: unknown[]) => Promise<any> }>;
let root: string;
let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
let requests: { url: string; body: Record<string, unknown>; key: string | undefined }[];
const saved: Record<string, string | undefined> = {};

/** A tone with a gap in the middle, as 16-bit mono PCM: audio the silence measurement can read. */
function pcm(): Buffer {
  const samples = Buffer.alloc(SAMPLE_RATE * SECONDS * 2);
  for (let i = 0; i < SAMPLE_RATE * SECONDS; i++) {
    const t = i / SAMPLE_RATE;
    const loud = t < 1.2 || t > 1.8;
    samples.writeInt16LE(loud ? Math.round(12_000 * Math.sin(2 * Math.PI * 300 * t)) : 0, i * 2);
  }
  return samples;
}

/** ElevenLabs' character alignment for a text spread evenly over the audio. */
function alignment(text: string) {
  const step = (SECONDS - 0.2) / text.length;
  return {
    characters: [...text],
    character_start_times_seconds: [...text].map((_, i) => 0.1 + i * step),
    character_end_times_seconds: [...text].map((_, i) => 0.1 + (i + 1) * step),
  };
}

async function tools(): Promise<ToolMap> {
  const { registerCapabilityTools } = await import("../src/capability-tools.js");
  const map: ToolMap = new Map();
  registerCapabilityTools({ registerTool: (t: { name: string }) => map.set(t.name, t as never) } as never);
  return map;
}
const call = async (name: string, params: Record<string, unknown>) =>
  (await tools()).get(name)!.execute("call-1", { ...REF, ...params }, undefined, undefined, undefined);
const speak = (params: Record<string, unknown> = {}) =>
  call("pva_synthesize_speech", { sceneId: "line-1", text: TEXT, provider: "elevenlabs", voiceId: VOICE, ...params });
const narration = (file: string) => join(dir, "artifacts", "narration", file);
const journal = () => existsSync(join(dir, JOURNAL_RELATIVE_PATH))
  ? parseJournal(readFileSync(join(dir, JOURNAL_RELATIVE_PATH), "utf-8"))
  : [];
const budget = (limitMicros: number) => writeFileSync(
  join(root, REF.channel, "series", REF.series, "settings.yaml"),
  `budget:\n  currency: USD\n  limitMicros: ${limitMicros}\n`,
);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pva-eleven-"));
  dir = join(root, REF.channel, "series", REF.series, "episodes", REF.episode);
  mkdirSync(join(dir, "journal"), { recursive: true });
  for (const name of ["AVG_LIBRARY_ROOT", "ELEVENLABS_API_KEY", "AVG_TTS_WORKER_URL"]) saved[name] = process.env[name];
  process.env.AVG_LIBRARY_ROOT = root;
  process.env.ELEVENLABS_API_KEY = KEY;
  // No worker anywhere near: these tests must never reach one.
  process.env.AVG_TTS_WORKER_URL = "http://127.0.0.1:9";
  requests = [];
  fetchMock = vi.fn(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    requests.push({ url, body, key: init?.headers?.["xi-api-key"] });
    return Response.json(
      { audio_base64: pcm().toString("base64"), alignment: alignment(String(body.text)) },
      { headers: { "request-id": "req-eleven-1" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("pva_synthesize_speech with provider elevenlabs", () => {
  it("says in its description what ElevenLabs costs and defaults to, from the profile", async () => {
    const tool = (await tools()).get("pva_synthesize_speech")!;
    expect(tool.description).toContain(elevenLabsSpeechTerms());
    expect(elevenLabsSpeechTerms()).toContain(SPEECH.defaultModel);
    expect(elevenLabsSpeechTerms()).toContain(String(SPEECH.usdPerThousandCharacters));
  });

  it("asks ElevenLabs for the voice with timestamps, with the profile's model and settings", async () => {
    const result = await speak({ languageCode: "en", seed: 7 });
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=${SPEECH.outputFormat}`);
    expect(requests[0]!.key).toBe(KEY);
    expect(requests[0]!.body).toEqual({ text: TEXT, model_id: SPEECH.defaultModel, language_code: "en", seed: 7, voice_settings: SPEECH.defaultVoiceSettings });
  });

  it("sends the caller's model and voice settings over the defaults", async () => {
    await speak({ model: "another-model", voiceSettings: { stability: 0.2, style: 0.6 } });
    expect(requests[0]!.body).toMatchObject({ model_id: "another-model", voice_settings: { ...SPEECH.defaultVoiceSettings, stability: 0.2, style: 0.6 } });
  });

  it("writes the WAV and a synthesis record with the words' timings", async () => {
    const result = await speak({ languageCode: "en", seed: 7 });
    const wav = readFileSync(narration("line-1.wav"));
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.length).toBe(44 + pcm().length);
    const record = JSON.parse(readFileSync(narration("line-1.synthesis.json"), "utf-8"));
    expect(record).toMatchObject({
      provider: "elevenlabs",
      requestId: "req-eleven-1",
      voiceId: VOICE,
      model: SPEECH.defaultModel,
      outputFormat: SPEECH.outputFormat,
      request: requests[0]!.body,
      text: TEXT,
      language: "en",
      wav: "artifacts/narration/line-1.wav",
      wavSha256: createHash("sha256").update(wav).digest("hex"),
      durationSeconds: SECONDS,
      characters: TEXT.length,
      estimatedCost: { amount: speechSynthesisUsd(TEXT.length), currency: "USD" },
    });
    expect(record.words.map((w: { text: string }) => w.text)).toEqual(TEXT.split(" "));
    expect(JSON.stringify(record)).not.toContain(KEY);
    expect(result.content[0].text).toContain('provider "synthesis"');
    expect(result.content[0].text).not.toContain(KEY);
  });

  it("reserves the profile's price for the text on the episode's ledger, and settles it", async () => {
    budget(10_000_000);
    await speak();
    const events = journal();
    expect(events.map((e) => e.type)).toEqual(["spend-reserved", "spend-settled"]);
    expect(events[0]!.data).toMatchObject({
      capability: "speech.synthesize", provider: "elevenlabs", profile: "elevenlabs-speech-synthesis", purpose: "speech line-1",
      estimate: { currency: "USD", micros: toMicros(speechSynthesisUsd(TEXT.length)) },
    });
  });

  it("refuses over budget without calling ElevenLabs", async () => {
    budget(toMicros(speechSynthesisUsd(TEXT.length)) - 1);
    const result = await speak();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/budget/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(narration("line-1.wav"))).toBe(false);
  });

  it("releases the reservation when ElevenLabs refuses the request", async () => {
    budget(10_000_000);
    fetchMock.mockImplementationOnce(async () => Response.json({ detail: { status: "voice_not_found", message: "no such voice" } }, { status: 422 }));
    const result = await speak();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no such voice");
    expect(journal().map((e) => e.type)).toEqual(["spend-reserved", "spend-released"]);
  });

  it("never switches provider: each one refuses the other's parameters, and the paid one must be named", async () => {
    // A voiceId without the provider does not quietly become a paid call.
    const implied = await call("pva_synthesize_speech", { sceneId: "a", text: TEXT, voiceId: VOICE });
    expect(implied.isError).toBe(true);
    expect(implied.content[0].text).toMatch(/provider: "elevenlabs"/);
    const mixed = await speak({ voice: "ryan", instruct: "warmly" });
    expect(mixed.isError).toBe(true);
    expect(mixed.content[0].text).toMatch(/voice, instruct are for the local worker/);
    const noVoice = await call("pva_synthesize_speech", { sceneId: "a", text: TEXT, provider: "elevenlabs" });
    expect(noVoice.content[0].text).toMatch(/needs voiceId/);
    delete process.env.ELEVENLABS_API_KEY;
    expect((await speak()).content[0].text).toMatch(/ELEVENLABS_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(journal()).toEqual([]);
  });

  it("is paid, so it runs in an episode, not in a source", async () => {
    mkdirSync(join(root, REF.channel, "sources", "voices"), { recursive: true });
    const tool = (await tools()).get("pva_synthesize_speech")!;
    const result = await tool.execute("call-1", { channel: REF.channel, source: "voices", sceneId: "a", text: TEXT, provider: "elevenlabs", voiceId: VOICE }, undefined, undefined, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/a source has no budget/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("from an ElevenLabs synthesis to a timed take, with one paid call", () => {
  it("registers the WAV and times it from the synthesis record", async () => {
    budget(10_000_000);
    await speak({ languageCode: "en" });
    const registered = await call("pva_register_take", {
      take: "line-1", audio: "artifacts/narration/line-1.wav", text: TEXT, language: "en",
      provider: "elevenlabs", model: SPEECH.defaultModel, voiceId: VOICE,
    });
    expect(registered.isError).toBeFalsy();
    const aligned = await call("pva_align_take", { take: "line-1", provider: "synthesis" });
    expect(aligned.isError, aligned.content[0].text).toBeFalsy();

    const takes = JSON.parse(readFileSync(narration("takes.json"), "utf-8"));
    const take = takes.takes.find((t: { id: string }) => t.id === "line-1");
    const timing = JSON.parse(readFileSync(join(dir, take.timing.path), "utf-8"));
    expect(validateWordTiming(timing, { audioHash: take.audio.hash })).toEqual([]);
    expect(timing.words.map((w: { text: string }) => w.text)).toEqual(TEXT.split(" "));
    expect(timing.alignment).toMatchObject({ provider: "elevenlabs", model: SPEECH.defaultModel, method: "forced" });
    // One request to ElevenLabs, one reservation: the alignment cost nothing.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(journal().map((e) => e.type)).toEqual(["spend-reserved", "spend-settled"]);
  });

  it("offers synthesis among the align providers", async () => {
    const tool = (await tools()).get("pva_align_take")!;
    expect(JSON.stringify(tool.parameters)).toContain("synthesis");
  });
});

describe("elevenLabsStatus", () => {
  it("reports speech and alignment, each ready only with the key", () => {
    const ready = elevenLabsStatus(true);
    expect(ready["text-to-speech-elevenlabs"]).toMatchObject({ available: true, detail: expect.stringContaining("pva_synthesize_speech") });
    expect(ready["speech-align-elevenlabs"]).toEqual({ available: true, detail: "ELEVENLABS_API_KEY set" });
    expect(elevenLabsStatus(false)["text-to-speech-elevenlabs"]).toEqual({ available: false, detail: "ELEVENLABS_API_KEY not set" });
  });
});
