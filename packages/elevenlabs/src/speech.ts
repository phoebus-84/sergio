// Speech synthesis with timestamps (avg-8hs.1): a text said by a voice, as a
// WAV, with when each word is said — measured by the model that spoke it, so
// no alignment call is needed afterwards.
// https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps

import type { AlignedWord } from "./alignment.js";
import { ElevenLabsError } from "./errors.js";
import { ELEVENLABS_PROFILES } from "./profiles.js";
import { postJson, type RequestOptions } from "./request.js";

export interface SynthesizeSpeechOptions extends RequestOptions {
  text: string;
  voiceId: string;
  /** Default: the profile's model. */
  modelId?: string;
  /** ISO 639-1, e.g. "it". */
  languageCode?: string;
  /** The same seed, text and settings ask for the same take again. */
  seed?: number;
  /** Merged over the profile's defaults, and sent as voice_settings. */
  voiceSettings?: Record<string, number | boolean>;
  /** Default: the profile's. Only raw PCM (`pcm_<sample rate>`). */
  outputFormat?: string;
}

export interface SynthesizedSpeech {
  /** 16-bit mono PCM in a WAV container. */
  wav: Buffer;
  sampleRate: number;
  durationSeconds: number;
  /** Characters of text sent: what the price is counted on. */
  characters: number;
  /**
   * The text's words — split at whitespace, audio tags like [laughs] left
   * out — each with its start and end in the WAV. Empty when ElevenLabs
   * returned no alignment.
   */
  words: AlignedWord[];
  modelId: string;
  outputFormat: string;
  /** The JSON body as sent. */
  request: Record<string, unknown>;
  requestId?: string;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const PCM_FORMAT = /^pcm_(\d+)$/;
const BYTES_PER_SAMPLE = 2;

/** Raw 16-bit mono PCM with the 44-byte header that makes it a WAV. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Words from ElevenLabs' character-level alignment: runs of characters
 * between whitespace, from the first one's start to the last one's end.
 * A bracketed audio tag ([whispers], [laughs]) directs the voice and is not
 * a word; it is left out. Returns [] when the alignment is missing or its
 * three lists disagree.
 */
export function wordsFromCharacterAlignment(alignment: unknown): AlignedWord[] {
  const a = alignment as { characters?: unknown; character_start_times_seconds?: unknown; character_end_times_seconds?: unknown } | null | undefined;
  const characters = a?.characters;
  const starts = a?.character_start_times_seconds;
  const ends = a?.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return [];
  if (starts.length !== characters.length || ends.length !== characters.length) return [];

  const words: AlignedWord[] = [];
  let text = "";
  let from = 0;
  let to = 0;
  let inTag = false;
  const close = () => {
    if (text !== "") words.push({ text, start: from, end: to });
    text = "";
  };
  characters.forEach((raw, i) => {
    const char = typeof raw === "string" ? raw : "";
    const start: unknown = starts[i];
    const end: unknown = ends[i];
    if (!inTag && char === "[") {
      close();
      inTag = true;
      return;
    }
    if (inTag) {
      if (char === "]") inTag = false;
      return;
    }
    if (char === "" || /^\s+$/.test(char) || !isNumber(start) || !isNumber(end)) {
      close();
      return;
    }
    if (text === "") {
      from = start;
      to = Math.max(start, end);
    } else {
      to = Math.max(to, end);
    }
    text += char;
  });
  close();
  return words;
}

export async function synthesizeSpeech(options: SynthesizeSpeechOptions): Promise<SynthesizedSpeech> {
  const profile = ELEVENLABS_PROFILES.speechSynthesis;
  const outputFormat = options.outputFormat ?? profile.outputFormat;
  const pcm = PCM_FORMAT.exec(outputFormat);
  // Refused here: nothing is sent, nothing is billed.
  if (!pcm) throw new ElevenLabsError("bad-request", `output format ${outputFormat} is not raw PCM (pcm_<sample rate>)`);
  if (options.text.trim() === "") throw new ElevenLabsError("bad-request", "the text is empty");
  if (!/^[A-Za-z0-9_-]+$/.test(options.voiceId)) throw new ElevenLabsError("bad-request", "the voice id is not an ElevenLabs voice id");
  const sampleRate = Number(pcm[1]);
  const modelId = options.modelId ?? profile.defaultModel;

  const request: Record<string, unknown> = {
    text: options.text,
    model_id: modelId,
    ...(options.languageCode ? { language_code: options.languageCode } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    voice_settings: { ...profile.defaultVoiceSettings, ...options.voiceSettings },
  };
  const { json, requestId } = await postJson(
    `/v1/text-to-speech/${options.voiceId}/with-timestamps?output_format=${outputFormat}`,
    request,
    options,
  );
  const answer = json as { audio_base64?: unknown; alignment?: unknown } | null;
  if (typeof answer?.audio_base64 !== "string" || answer.audio_base64 === "") {
    throw new ElevenLabsError("uncertain", "ElevenLabs answered without audio; the request may have been processed");
  }
  const samples = Buffer.from(answer.audio_base64, "base64");
  return {
    wav: pcmToWav(samples, sampleRate),
    sampleRate,
    durationSeconds: samples.length / (sampleRate * BYTES_PER_SAMPLE),
    characters: options.text.length,
    words: wordsFromCharacterAlignment(answer.alignment),
    modelId,
    outputFormat,
    request,
    ...(requestId ? { requestId } : {}),
  };
}
