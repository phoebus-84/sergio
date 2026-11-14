# @av/elevenlabs

A small client for the ElevenLabs API, with the studio's rate and retry
rules. It supports forced alignment and speech synthesis with word timestamps.

```ts
import { forcedAlignment, ELEVENLABS_PROFILES, ElevenLabsError } from "@av/elevenlabs";

const { words, loss } = await forcedAlignment({
  audioPath: "/abs/take.wav",
  text: "La nebbia a gl'irti colli",
  apiKey: process.env.ELEVENLABS_API_KEY!,   // the caller reads the key; this package reads no environment
});
// words: [{ text, start, end, loss? }]
```

## Speech synthesis

```ts
import { synthesizeSpeech } from "@av/elevenlabs";

const { wav, words, durationSeconds } = await synthesizeSpeech({
  text: "Buongiorno a tutti.",
  voiceId: "your-voice-id",
  apiKey: process.env.ELEVENLABS_API_KEY!,
  modelId: "eleven_v3",
  languageCode: "it",
  seed: 7,
});
```

Uses `/v1/text-to-speech/{voice_id}/with-timestamps`, wraps PCM in WAV,
and converts character timestamps into words. Defaults and price estimates
live in `ELEVENLABS_PROFILES.speechSynthesis`.

In the studio, explicitly select `provider: "elevenlabs"` and `voiceId` in
`pva_synthesize_speech`. It writes `artifacts/narration/<sceneId>.wav` and
`<sceneId>.synthesis.json` through the spend ledger. Register that WAV with
`pva_register_take`, then call `pva_align_take` with `provider: "synthesis"`
to reuse its timings without another paid request. Qwen remains the default;
there is no automatic provider fallback.

## Rules

- One request at a time per process.
- At most two retries, only for 429 and 503 — answers that say the request
  was not processed — waiting `Retry-After` (seconds or a date; or 2 s, then
  4 s). A wait over 30 s is not waited: the call fails `rate-limited` and
  says when to retry.
- Never a retry for a refused key (`auth`), a spent quota (`quota`), or any
  other 5xx (`server`): after a 500 or a 504 the work may have been done,
  and billed.
- A connection lost after the request left is `uncertain` and not retried:
  it may have been processed, and billed. No connection at all is
  `unreachable`: nothing was sent.
- The key never appears in an error.

`ElevenLabsError.code`: `auth`, `quota`, `rate-limited`, `bad-request`,
`server`, `unreachable`, `uncertain`.

## Price

ElevenLabs returns no price for alignment; `ELEVENLABS_PROFILES.forcedAlignment.usdPerMinute`
is an estimate the studio's spend ledger reserves and settles at. Edit it
when the plan's price changes.

## Tests

```bash
npm test --workspace @av/elevenlabs   # against a local fake of the API; no key, no network
```
