// synthesizeSpeech against a local fake of the ElevenLabs API: what is sent,
// how the audio and the timestamps are read, and that the request rules of
// this package (UP-39) hold for it too.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ELEVENLABS_PROFILES,
  ElevenLabsError,
  speechSynthesisUsd,
  synthesizeSpeech,
  wordsFromCharacterAlignment,
} from "../src/index.js";

const KEY = "sk_test_never_print_me";
const VOICE = "fakeVoice123";
type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void;
let server: Server;
let baseUrl: string;
let handlers: Handler[];
let requests: { url: string; headers: IncomingMessage["headers"]; body: string }[];
const waits: number[] = [];
const sleep = async (ms: number) => { waits.push(ms); };

beforeEach(async () => {
  handlers = [];
  requests = [];
  waits.length = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ url: req.url ?? "", headers: req.headers, body: body.toString("utf-8") });
      const handler = handlers.shift();
      if (!handler) { res.writeHead(500); res.end(); return; }
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (_req, _body, res) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** A character alignment that gives every character 0.1 s, one after the other. */
const alignmentOf = (text: string) => ({
  characters: [...text],
  character_start_times_seconds: [...text].map((_, i) => Number((i * 0.1).toFixed(3))),
  character_end_times_seconds: [...text].map((_, i) => Number(((i + 1) * 0.1).toFixed(3))),
});
const TEXT = "Ciao, come va?";
/** Half a second of 24 kHz 16-bit mono silence. */
const PCM = Buffer.alloc(24_000);
const ANSWER = { audio_base64: PCM.toString("base64"), alignment: alignmentOf(TEXT), normalized_alignment: alignmentOf(TEXT) };
const speak = (extra: Record<string, unknown> = {}) => synthesizeSpeech({ text: TEXT, voiceId: VOICE, apiKey: KEY, baseUrl, sleep, ...extra });
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as ElevenLabsError);

describe("synthesizeSpeech", () => {
  it("asks the voice for PCM with timestamps, with the profile's model and settings", async () => {
    handlers.push(json(200, ANSWER, { "request-id": "req-abc" }));
    const result = await speak();
    const profile = ELEVENLABS_PROFILES.speechSynthesis;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`/v1/text-to-speech/${VOICE}/with-timestamps?output_format=${profile.outputFormat}`);
    expect(requests[0]!.headers["xi-api-key"]).toBe(KEY);
    expect(requests[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(requests[0]!.body)).toEqual({ text: TEXT, model_id: profile.defaultModel, voice_settings: profile.defaultVoiceSettings });
    expect(result.request).toEqual(JSON.parse(requests[0]!.body));
    expect(result).toMatchObject({ modelId: profile.defaultModel, outputFormat: profile.outputFormat, requestId: "req-abc", characters: TEXT.length });
  });

  it("sends the language, the seed, the model and the caller's settings over the defaults", async () => {
    handlers.push(json(200, ANSWER));
    await speak({ languageCode: "it", seed: 7, modelId: "eleven_other", voiceSettings: { stability: 1, style: 0.2 } });
    expect(JSON.parse(requests[0]!.body)).toEqual({
      text: TEXT,
      model_id: "eleven_other",
      language_code: "it",
      seed: 7,
      voice_settings: { ...ELEVENLABS_PROFILES.speechSynthesis.defaultVoiceSettings, stability: 1, style: 0.2 },
    });
  });

  it("wraps the PCM in a WAV and measures it", async () => {
    handlers.push(json(200, ANSWER));
    const { wav, sampleRate, durationSeconds } = await speak();
    expect([sampleRate, durationSeconds]).toEqual([24_000, 0.5]);
    expect(wav.length).toBe(44 + PCM.length);
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.toString("latin1", 8, 16)).toBe("WAVEfmt ");
    expect([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt32LE(28), wav.readUInt16LE(34), wav.readUInt32LE(40)])
      .toEqual([1, 1, 24_000, 48_000, 16, PCM.length]);
  });

  it("turns the character timestamps into words", async () => {
    handlers.push(json(200, ANSWER));
    const { words } = await speak();
    expect(words).toEqual([
      { text: "Ciao,", start: 0, end: 0.5 },
      { text: "come", start: 0.6, end: 1 },
      { text: "va?", start: 1.1, end: 1.4 },
    ]);
  });

  it("returns the audio with no words when ElevenLabs sends no alignment", async () => {
    handlers.push(json(200, { audio_base64: ANSWER.audio_base64, alignment: null }));
    const result = await speak();
    expect(result.words).toEqual([]);
    expect(result.durationSeconds).toBe(0.5);
  });

  it("calls an answer without audio uncertain: it may have been billed", async () => {
    handlers.push(json(200, { alignment: alignmentOf(TEXT) }));
    expect((await failure(speak())).code).toBe("uncertain");
  });

  it("refuses an empty text, a bad voice id and a compressed format without sending anything", async () => {
    for (const extra of [{ text: "  " }, { voiceId: "../voices" }, { outputFormat: "mp3_44100_128" }]) {
      expect((await failure(speak(extra))).code).toBe("bad-request");
    }
    expect(requests).toHaveLength(0);
  });

  it("follows the package's retry rules", async () => {
    handlers.push(json(429, { detail: "slow down" }, { "retry-after": "3" }), json(200, ANSWER));
    await speak();
    expect(waits).toEqual([3000]);
    requests = [];
    handlers.push(json(500, { detail: "upstream" }), json(200, ANSWER));
    const error = await failure(speak());
    expect([error.code, requests.length]).toEqual(["server", 1]);
    handlers.length = 0;
  });

  it("never retries a refused key or a spent quota, and keeps the key out of the error", async () => {
    handlers.push(json(401, { detail: { status: "invalid_api_key", message: `key ${KEY} is not valid` } }));
    const auth = await failure(speak());
    expect(auth.code).toBe("auth");
    expect(auth.message).not.toContain(KEY);
    handlers.push(json(401, { detail: { status: "quota_exceeded", message: "no credits left" } }));
    expect((await failure(speak())).code).toBe("quota");
    expect(requests).toHaveLength(2);
  });
});

describe("wordsFromCharacterAlignment", () => {
  it("leaves audio tags out: they direct the voice and are not said", () => {
    const words = wordsFromCharacterAlignment(alignmentOf("[whispers] Piano, [laughs] dai"));
    expect(words.map((w) => w.text)).toEqual(["Piano,", "dai"]);
    expect(words[0]).toMatchObject({ start: 1.1, end: 1.7 });
  });

  it("splits at every kind of whitespace, including line ends", () => {
    expect(wordsFromCharacterAlignment(alignmentOf("uno\ndue\t tre")).map((w) => w.text)).toEqual(["uno", "due", "tre"]);
  });

  it("gives no words for an alignment it cannot read", () => {
    expect(wordsFromCharacterAlignment(undefined)).toEqual([]);
    expect(wordsFromCharacterAlignment({ characters: ["a"], character_start_times_seconds: [], character_end_times_seconds: [] })).toEqual([]);
  });
});

describe("speechSynthesisUsd", () => {
  it("prices the characters at the profile's rate", () => {
    expect(speechSynthesisUsd(1000)).toBeCloseTo(ELEVENLABS_PROFILES.speechSynthesis.usdPerThousandCharacters, 6);
    expect(speechSynthesisUsd(0)).toBe(0);
  });
});
