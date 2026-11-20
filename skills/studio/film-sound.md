---
name: film-sound
version: "0.2.0"
description: Make a film's sound — dialogue recorded or synthesised and checked against its lines, ambience and effects recorded, licensed or generated, music spotted against the scenes — and lay it on the cut's tracks at levels that mix
inputs:
  - name: film
    type: string
    description: The film's slug
  - name: scene
    type: string
    description: For a scene's sound, the scene's slug; omitted for the film's music
outputs:
  - assets/audio/:
      kind: directory
      description: A scene's dialogue takes, effects and ambience, each with its provenance
  - artifacts/scene-sound.json:
      kind: file
      description: Every sound of the scene — what it is, the file, where it sits against the picture, and how it was checked
  - music/:
      kind: directory
      description: The film's music with its provenance and licence
  - artifacts/score.json:
      kind: file
      description: The film's cues — the file, the scenes it plays over, where it enters and leaves, and its terms
capabilities:
  - llm
---

# A Film's Sound

Half of a film is what is heard, and it is made in two places:

- a **scene's sound** (stage `sound` on `<film>/<scene>/_`): its dialogue,
  its ambience, its effects → `assets/audio/` and
  `artifacts/scene-sound.json`;
- the **film's music** (stage `score` on `<film>/_/_`) → `music/` and
  `artifacts/score.json`.

Putting them on the timeline is part of each level's **cut** stage, and is
described at the end.

You cannot hear. Everything here is checked by what can be measured or read
back — a transcript, a duration, a loudness — and what could not be checked
is said, so a person knows what to listen to.

## Four kinds of track

A cut's sound tracks carry a `role`, and the role is how the mix is kept
legible at every level:

| role | carries | sits at (integrated) |
| --- | --- | --- |
| `dialogue` | spoken lines, narration | −18 to −14 LUFS: the reference everything else is set against |
| `ambience` | the place: room tone, air, traffic, weather | 15–25 dB under dialogue |
| `effects` | events: a door, steps, a phone | their natural level against dialogue; never above it unless that is the point |
| `music` | score and source music | 6–12 dB under dialogue while there is speech — by ducking, not by a fixed low level |

A picture clip's own sound (a `sync` shot) plays from the picture track.
Leave it there; set its level on the clip (`audio.gain`).

## A scene's sound

Read `artifacts/scene-direction.md` — its **Sound** section is the brief —
the shots' `dialogue` in their `shot.yaml`, the bible's Voices and Sound,
and the footage log for what was recorded
(`pva_footage { film, scene, origin: "recording" }`).

### Dialogue

For each line, in the order it is spoken:

1. **Recorded?** A `sync` shot carries its own. A wild track or ADR in the
   footage log is used as `project:footage/media/<file>`.
2. **Otherwise synthesise it**, with the voice the bible gives the
   character: `pva_voices`, then `pva_synthesize_speech` on the scene's
   unit, one file per line or per speech, the `delivery` from the shot as
   the direction for the read. The local worker (MLX or Torch) is the default.
   Only when the operator asks for ComfyUI, pass `provider: "comfyui-qwen"`;
   cloned or saved voices require an operator-created `voiceConsentPath`
   bound to the reference or saved name. Never choose it as a fallback or
   create consent on the operator's behalf. The same take flow follows.
3. **Register and verify the take** — `pva_register_take`,
   `pva_align_take`, `pva_verify_take` (the `narration` skill has the
   detail). Verification reads the take back and compares it with the line:
   a wrong word, a dropped phrase or a read twice as long as the shot is
   caught here, not in the mix.
4. **Fit it to the picture.** The line must fit the shot it is said in
   (`durationSeconds`), with air around it. Too long: a tighter read, not a
   faster playback. Still too long: the shot is too short — say so; the cut
   can hold it longer.

### Ambience

Every scene has one, continuous, from its first frame to its last: it is
what makes separate shots one place. In this order:

1. Room tone or a wild track recorded on the day (footage log).
2. A licensed recording — the `find-archive-media` skill.
3. `pva_synthesize_sound` — wind, rain, sea, hum, room: procedural, local
   and free. Honest for a bed; not a substitute for a specific place.
4. Designed in code — a drone with a slow movement, a room tone in a key, a
   texture that changes with the scene: the `strudel-sounds` skill, rendered
   with `pva_music_render` as a seamless `loop`.

Make it at least as long as the scene, or loop a seamless piece.

### Effects

Only what the picture shows or the story needs: list them from the
direction, then find each — recorded, licensed, or `pva_synthesize_sound` /
`pva_synthesize_nonverbal_audio` for what those can make. What is designed
rather than recorded — a riser into a cut, an impact, a whoosh, a tone, an
interface blip — is written as code (`strudel-sounds`) and rendered with
`pva_music_render` to `assets/audio/effects/`. An effect is placed on the
frame its cause is seen.

To trim, join, clean or level a file before it goes on a track, use
`pva_edit_audio` (the `audio-editing` skill): the edit is a saved recipe,
and the original stays.

### The record

`artifacts/scene-sound.json`:

```json
{
  "dialogue": [
    { "shot": "020-close-mara", "character": "MARA", "line": "That can't be right.",
      "file": "assets/audio/dialogue/mara-010.wav", "seconds": 1.4, "voice": "clone:mara",
      "verified": "transcript matches; 1.4 s in a 4 s shot" }
  ],
  "ambience": [ { "file": "assets/audio/ambience/night-air.wav", "seconds": 40, "from": "pva_synthesize_sound: wind, low" } ],
  "effects": [ { "file": "project:footage/media/car-door-1f3a9c22.wav", "at": "010-wide, 3.2 s", "from": "recorded on the day" } ],
  "unchecked": ["Whether the synthesised line sits in the same room as the sync sound of 010-wide: listen."]
}
```

## The film's music

Read the bible's Sound section and the breakdown. Then **spot** the film:
decide where music is and — more often the better decision — where it is
not. A cue has a reason: it carries a transition, holds a feeling across a
cut, or marks a change.

Where the music comes from. What the person asked for decides; when
nobody asked for anything, compose it here as code (3), the default. Every
source is legitimate, and each cue keeps where it came from:

1. **What the person supplied**: a composer's cues or stems, brought in
   with `pva_ingest_footage` or placed under `music/`.
2. **Licensed music**: the `find-archive-media` skill. The licence and its
   evidence are kept with the file; a cue without terms cannot ship.
3. **Composed here, as code** — the default: the `strudel-music` skill (with
   `strudel-forms` for a cue's shape and `strudel-sounds` for its
   instruments). Each cue is a piece, `music/<cue>.strudel` on the film
   (`series: "_"`, `episode: "_"`), written to the spotting:
   - its tempo and length are chosen so that it turns where the picture
     does — a cue's seconds are its cycles over its tempo, so a change that
     must land on a cut is put on the cycle that falls there;
   - rendered with `pva_music_render` to `music/<cue>.wav`, with a `tail`
     for a cue that ends and `stems: true` when the cut will mix its parts;
   - the same piece gives the variants a film needs — a section alone
     (`from`, `cycles`), without its melody (`mute`), one instrument
     (`only`) — rather than a new piece for each.

   Code gives a synthesizer's sound. When a cue wants an orchestra, a
   singer or a sound only a recording gives, say so and offer the other
   sources — supplied, licensed, or generated — rather than cover it with a
   pad: which one is the person's decision.
4. **Generated with a model**: a music workflow on the operator's ComfyUI
   server (`ace-step-music`, or one of theirs; the `comfyui-workflows`
   skill), when the person chooses it, or offered when a cue needs what code
   does not give and `pva_capability_status` says a music workflow can run.
   `pva_comfyui_run` on the film with the cue's `tags` (genre, instruments,
   voice, mood, tempo), its `lyrics` (`[verse]`, `[chorus]`… or `[inst]`),
   its `seconds` and a `seed`, writes `music/<cue>.flac` and its receipt —
   workflow, model, seed, tags and lyrics: the same provenance as any
   generated take.
   - A generated cue is not cut to the frame as a piece of code is: make it
     a few seconds longer than its place, and set where it starts, where it
     ends and its fades in the cut.
   - Another take is another `seed`; keep the one the person chose.
   - The model's licence and the operator's terms for what it makes go in
     the cue's `terms`, as for any music.

`pva_music_render` returns a cue's length, loudness, spectrum and the level
of each stem; `pva_analyze_audio` measures a file that came from elsewhere —
supplied, licensed or generated. Use them to place it. `pva_music` lists the
pieces, their renders and the generated cues of a unit.

`artifacts/score.json`:

```json
{
  "cues": [
    { "id": "theme", "file": "music/theme.wav", "seconds": 62,
      "over": ["010-car-park", "020-ward"], "enters": "010-car-park, on the cut to the clock",
      "leaves": "020-ward, under the first line, out by its end",
      "terms": "CC BY 4.0 — <author>, <url>; credit in the end titles" },
    { "id": "ward", "file": "music/ward.wav", "seconds": 48,
      "over": ["020-ward"], "enters": "020-ward, with the first shot", "leaves": "020-ward, rings out over the cut",
      "terms": "composed for this film: music/ward.strudel" },
    { "id": "night", "file": "music/night.flac", "seconds": 75,
      "over": ["040-harbour"], "enters": "040-harbour, under the boat's horn", "leaves": "040-harbour, fades with the lights",
      "terms": "generated for this film: ace-step-music, seed 4417 (music/night.flac.comfyui.json); the model's licence, the operator's terms" }
  ],
  "silence": ["030-corridor: no music; the ventilation hum is the scene."],
  "credits": ["Music: “Theme” by <author>, CC BY 4.0"]
}
```

## On the timeline

With `pva_edit_cut` on the unit's cut (the `film-editing` skill has every
operation). Positions and lengths are **frames**; where a clip starts in
its file is **seconds**; levels are **dB**.

```json
[
  { "op": "add-track", "track": { "id": "dx", "kind": "audio", "name": "Dialogue", "role": "dialogue" } },
  { "op": "add-track", "track": { "id": "amb", "kind": "audio", "name": "Ambience", "role": "ambience", "gain": -20 } },
  { "op": "add-clip", "track": "dx", "clip": { "id": "mara-010", "source": { "path": "assets/audio/dialogue/mara-010.wav" }, "at": 98, "duration": 34 } },
  { "op": "add-clip", "track": "amb", "clip": { "id": "night-air", "source": { "path": "assets/audio/ambience/night-air.wav" }, "at": 0, "duration": 152, "fadeIn": 12, "fadeOut": 12 } }
]
```

- **Scene level**: `dialogue`, `ambience`, `effects`. Every sound clip gets
  a short `fadeIn` / `fadeOut` (2–6 frames) so it never starts on a click;
  ambience fades over half a second at the scene's ends.
- **Film level**: `music`, ducked under what speaks —
  `"duck": { "under": ["v1"], "gain": -8 }` on the music track, where `v1`
  is the picture track whose scenes carry the dialogue. Music enters and
  leaves on fades of a second or more unless it is cut on purpose.
- **Clean before you level.** A `highpass` at 80 Hz on dialogue, a
  `denoise` or `deesser` where a take needs it, a gentle `compressor` on a
  dialogue track: each is an effect from `pva_cut_effects`, on the clip or
  on the track.
- **The master.** Only the film is brought to a delivery loudness — its
  `master.loudness`, or the film format's own when the cut gives none:
  −16 LUFS for online, −23 for broadcast, −27 for cinema, true peak at or
  under −1 dBTP. A shot and a scene keep the levels they were mixed at.

After a render, the report gives the mix's measured loudness, and
`pva_inspect_media` on the render measures it again. Check the number
against the target, and say what a person should listen for.
