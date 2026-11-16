// ---------------------------------------------------------------------------
// Speech through ElevenLabs (avg-8hs.1)
// ---------------------------------------------------------------------------
// `pva_synthesize_speech` speaks through the local Qwen worker unless the
// caller names provider "elevenlabs" and a voice id: the provider is never
// switched for them. This module is that branch: one paid call, reserved on
// the episode's spend ledger at the profile's price per character, a WAV in
// artifacts/narration/ and a synthesis record beside it.
//
// The record keeps the words ElevenLabs timed while it spoke, so the take
// needs no second paid call: pva_register_take, then pva_align_take with
// provider "synthesis" (studio/episode take-align.ts reads this record by the
// audio's hash).
//
// The model, the output format, the default voice settings and the price are
// @av/elevenlabs' profile; nothing about a voice or a channel is known here.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ELEVENLABS_PROFILES, ElevenLabsError, speechSynthesisUsd, synthesizeSpeech } from "@av/elevenlabs";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { paidCall, type PaidCallTarget } from "./spend.js";

export const ELEVENLABS_PROVIDER = "elevenlabs";
export const ELEVENLABS_SPEECH_PROFILE = "elevenlabs-speech-synthesis";
/** ElevenLabs answers that say no work was done: the reservation is released. */
const NOT_BILLED = new Set(["auth", "quota", "rate-limited", "bad-request", "unreachable"]);

/** What the tool says about ElevenLabs' price and defaults, from the profile. */
export function elevenLabsSpeechTerms(): string {
  const p = ELEVENLABS_PROFILES.speechSynthesis;
  const settings = Object.entries(p.defaultVoiceSettings).map(([k, v]) => `${k} ${v}`).join(", ");
  return `about $${p.usdPerThousandCharacters} per 1000 characters (an estimate), model ${p.defaultModel} unless model is given, voice settings ${settings} unless voiceSettings changes them`;
}

export interface ElevenLabsSpeechRequest {
  /** The workspace the WAV is written in. */
  dir: string;
  /** The episode whose ledger pays. */
  target: PaidCallTarget;
  sceneId: string;
  text: string;
  voiceId: string;
  apiKey: string;
  model?: string;
  languageCode?: string;
  seed?: number;
  voiceSettings?: Record<string, number | boolean>;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface ElevenLabsSpeechResult {
  audioPath: string;
  receiptPath: string;
  durationSeconds: number;
  wordCount: number;
  estimatedCostUsd: number;
  receipt: Record<string, unknown>;
}

export async function synthesizeWithElevenLabs(r: ElevenLabsSpeechRequest): Promise<ElevenLabsSpeechResult> {
  const estimatedCostUsd = speechSynthesisUsd(r.text.length);
  const speech = await paidCall(
    r.target,
    {
      capability: "speech.synthesize",
      provider: ELEVENLABS_PROVIDER,
      model: r.model ?? ELEVENLABS_PROFILES.speechSynthesis.defaultModel,
      purpose: `speech ${r.sceneId}`,
      estimate: { estimate: { currency: "USD", micros: toMicros(estimatedCostUsd) }, priced: true, profile: ELEVENLABS_SPEECH_PROFILE },
    },
    async (spend) => {
      spend.sending();
      try {
        const value = await synthesizeSpeech({
          text: r.text,
          voiceId: r.voiceId,
          apiKey: r.apiKey,
          ...(r.model ? { modelId: r.model } : {}),
          ...(r.languageCode ? { languageCode: r.languageCode } : {}),
          ...(r.seed !== undefined ? { seed: r.seed } : {}),
          ...(r.voiceSettings ? { voiceSettings: r.voiceSettings } : {}),
          ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
          ...(r.signal ? { signal: r.signal } : {}),
        });
        return { value, ...(value.requestId ? { providerRequestId: value.requestId } : {}) };
      } catch (e) {
        if (e instanceof ElevenLabsError && NOT_BILLED.has(e.code)) spend.refused();
        throw e;
      }
    },
  );

  const narrationDir = join(r.dir, "artifacts", "narration");
  const audioPath = join(narrationDir, `${r.sceneId}.wav`);
  const receiptPath = join(narrationDir, `${r.sceneId}.synthesis.json`);
  mkdirSync(narrationDir, { recursive: true });
  writeFileSync(audioPath, speech.wav);
  const durationSeconds = Math.round(speech.durationSeconds * 1000) / 1000;
  const receipt = {
    provider: ELEVENLABS_PROVIDER,
    endpoint: "POST /v1/text-to-speech/{voice_id}/with-timestamps",
    ...(speech.requestId ? { requestId: speech.requestId } : {}),
    voiceId: r.voiceId,
    model: speech.modelId,
    outputFormat: speech.outputFormat,
    request: speech.request,
    text: r.text,
    ...(r.languageCode ? { language: r.languageCode } : {}),
    wav: `artifacts/narration/${r.sceneId}.wav`,
    wavSha256: createHash("sha256").update(speech.wav).digest("hex"),
    durationSeconds,
    characters: speech.characters,
    estimatedCost: { amount: estimatedCostUsd, currency: "USD" },
    // When each word is said, as ElevenLabs timed it: what pva_align_take reads with provider "synthesis".
    words: speech.words.map((w) => ({ text: w.text, start: Math.round(w.start * 1000) / 1000, end: Math.round(w.end * 1000) / 1000 })),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { audioPath, receiptPath, durationSeconds, wordCount: speech.words.length, estimatedCostUsd, receipt };
}
