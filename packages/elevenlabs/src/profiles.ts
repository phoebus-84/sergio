// What ElevenLabs calls are estimated to cost, and what a call is sent with
// when the caller does not say. ElevenLabs returns no price, so the spend
// ledger settles at these estimates: edit them when the plan's price changes.

export interface PriceProfile {
  /** US dollars per minute of audio. */
  usdPerMinute: number;
  /** Always true: a published price, not one the provider reported. */
  estimate: true;
}

export interface SpeechProfile {
  /** US dollars per thousand characters of text sent. */
  usdPerThousandCharacters: number;
  /** Always true: a published price, not one the provider reported. */
  estimate: true;
  /** The model a call uses when it names none. */
  defaultModel: string;
  /** Raw PCM, which becomes a WAV without a decoder: `pcm_<sample rate>`. */
  outputFormat: string;
  /** Sent as voice_settings, under whatever the caller sets. */
  defaultVoiceSettings: Readonly<Record<string, number | boolean>>;
}

export const ELEVENLABS_PROFILES: Readonly<{ forcedAlignment: PriceProfile; speechSynthesis: SpeechProfile }> = Object.freeze({
  // Billed like speech-to-text: about $0.40 an hour of audio.
  forcedAlignment: Object.freeze({ usdPerMinute: 0.0067, estimate: true as const }),
  // One credit a character; about $0.30 per thousand at the small plans'
  // price, less on the larger ones: the estimate errs on the dear side.
  speechSynthesis: Object.freeze({
    usdPerThousandCharacters: 0.3,
    estimate: true as const,
    defaultModel: "eleven_v3",
    outputFormat: "pcm_24000",
    defaultVoiceSettings: Object.freeze({ stability: 0.5, similarity_boost: 0.75 }),
  }),
});

/** What synthesizing `characters` of text is estimated to cost, in US dollars. */
export const speechSynthesisUsd = (characters: number): number =>
  Math.round((characters / 1000) * ELEVENLABS_PROFILES.speechSynthesis.usdPerThousandCharacters * 1e6) / 1e6;
