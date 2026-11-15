---
name: film-editing
version: "0.1.0"
description: Edit and finish a film's cut at any level — assemble it, trim and join, lay sound, grade with effects, check it, look at frames, render it and review the render — leaving alone whatever a person locked
inputs:
  - name: film
    type: string
    description: The film's slug
  - name: scene
    type: string
    description: A scene's slug, for a scene's cut or with shot, a shot's; omitted for the film's cut
  - name: shot
    type: string
    description: A shot's slug, with scene
outputs:
  - artifacts/cut.json:
      kind: file
      description: The unit's cut — a studio.video/v1alpha1 CutTimeline of tracks, clips, effects, markers and a master
  - output/:
      kind: directory
      description: Renders as output/<render-id>.mp4 with <render-id>.report.json; output/current.json names the final, output/preview.json the latest preview
  - artifacts/cut-render.json:
      kind: file
      description: The record of the unit's render — what it was rendered from and what it measured
  - artifacts/film-review.json:
      kind: file
      description: For the film's final review, every problem found, located by timecode, and the verdict
capabilities:
  - video.compose
---

# Edit a Film's Cut

Every level of a film has a **cut**: `artifacts/cut.json`, a timeline of
tracks and clips that the renderer turns into `output/<render-id>.mp4`.
The same document and the same tools at all three levels; what differs is
what the clips are.

| level | its picture track holds | the edit is |
| --- | --- | --- |
| shot | one clip of its take | the trim, the framing, the repair and the look |
| scene | its shots' renders, in cutting order | the rhythm, the joins, dialogue, ambience and effects |
| film | its scenes' renders, in running order | the joins between scenes, music, titles and credits, the overall grade and the mix |

A clip's source is exactly one of:

- `{ "unit": "<slug>" }` — the **current render** of a unit under this one
  (a shot of this scene, a scene of this film). The cut follows it: render
  the shot again and the scene's cut shows the new one.
- `{ "path": "assets/…" }` — a file of this unit.
- `{ "project": "footage/media/…" }` — a file of the film: footage, music.
- `{ "color": "#000000" }` — a solid frame.

**Units.** Positions and lengths on the timeline are **frames**. Where a
clip starts in its source (`in`) is **seconds**. Levels are **dB**. The
frame rate is the film's, in the cut's `format`.

## The loop

1. **Assemble** — `pva_assemble_cut`. It makes the cut or brings it in step
   with what is under the unit, and touches only the picture track's unit
   clips: sound, titles, effects, trims and anything locked stay as they
   are. Run it again whenever a shot or scene is added, removed, reordered
   or changes length.
   - A shot: `{ film, scene, shot, media, in, seconds }` cuts it from a
     take; `replace: true` to change the take of a shot already cut.
   - A scene or the film: `{ film, scene? }`, optionally with
     `transition: { type, duration }` to join every clip that way.
2. **Read** — `pva_check_cut` shows the cut track by track with its
   revision, and what a render would refuse or warn about.
3. **Edit** — `pva_edit_cut { ops, expectedRevision }`.
4. **Look** — `pva_cut_frame { seconds }` composes one frame with every
   effect and transition. Open the image. It costs nothing next to a
   render and is how a grade, a framing or a dissolve is judged.
5. **Render** — `pva_render_cut`, `quality: "preview"` to judge timing,
   `"final"` when it is right.
6. **Review** the render, below.

## Editing

`pva_edit_cut` takes a list of operations applied **together or not at
all**: the result must be a valid cut. Pass the `expectedRevision` you read
— if a person saved an edit meanwhile, yours is refused rather than laid
over theirs; read the cut again and redo it on what is there.

| operation | does |
| --- | --- |
| `{ "op": "add-track", "track": { "id", "kind": "video"\|"audio", "name"?, "role"?, "gain"?, "duck"?, "effects"? }, "index"? }` | adds a track. Picture tracks stack: a later one is drawn over an earlier one |
| `{ "op": "set-track", "track": "<id>", "set": { … } }` | changes a track's fields; `null` removes one |
| `{ "op": "remove-track", "track": "<id>" }` | removes it and its clips |
| `{ "op": "add-clip", "track": "<id>", "clip": { "id", "source", "duration", "at"?, … }, "after"?: "<clip>", "ripple"? }` | adds a clip at `at`, or straight after another clip; `ripple` pushes what follows |
| `{ "op": "set-clip", "clip": "<id>", "set": { … } }` | changes a clip's fields; `null` removes one |
| `{ "op": "move-clip", "clip": "<id>", "at"?, "track"?, "after"?, "ripple"? }` | moves it in time or to another track of its kind |
| `{ "op": "split-clip", "clip": "<id>", "at": <frame>, "newId": "<id>" }` | cuts it in two at a frame of the timeline |
| `{ "op": "remove-clip", "clip": "<id>", "ripple"? }` | removes it; `ripple` closes the gap |
| `{ "op": "set-master", "set": { "video"?, "audio"?, "loudness"? } }` | the chain over the whole cut |
| `{ "op": "set-marker", "marker": { "id", "at", "label"?, "note"? } }` · `{ "op": "remove-marker", "marker": "<id>" }` | a named instant |

A clip's fields:

| field | meaning |
| --- | --- |
| `at`, `duration` | where it starts and how long it holds, frames |
| `in` | where it starts in its source, seconds |
| `speed` | 0.1–10; 0.5 is half speed |
| `fit` | picture: `cover` (fill the frame, crop the rest), `contain` (all of it, bars), `fill` (stretch) |
| `opacity` | picture: 0–1, for a layer over another |
| `transitionIn`, `transitionOut` | picture: `{ "type": "dissolve"\|"fade"\|"wipe-left"\|"wipe-right"\|"wipe-up"\|"wipe-down", "duration": <frames> }` |
| `effects` | a chain of `{ "type", "params" }`: picture effects on a picture clip, sound effects on a sound clip |
| `audio` | a picture clip's own sound: `{ "mute", "gain", "fadeIn", "fadeOut", "effects" }` |
| `gain`, `fadeIn`, `fadeOut` | a sound clip's level and fades |
| `label`, `note` | for whoever reads the timeline |

Rules the cut is held to — `pva_edit_cut` refuses an edit that breaks one,
and says which:

- Clip ids are unique in the whole cut; track ids are unique.
- On a picture track, clips are in order and **do not overlap, except by
  the incoming clip's `transitionIn`**: that overlap *is* the dissolve. To
  dissolve B over the last 12 frames of A, B starts 12 frames before A ends
  and has `transitionIn: { "type": "dissolve", "duration": 12 }`.
- `fade` is from or to black and needs no overlap.
- A transition or a fade is no longer than its clip.
- Sound clips may overlap freely: they mix.

### Trimming

A trim is `set-clip` on `in` and `duration` (and `at`, to keep the clips
after it where they were, or `ripple` on a move to pull them up). Cut on
action; leave a line a few frames of air before it and after; a shot that
only repeats what the last one said is too long by its whole length.

For a J or L cut — sound leading or trailing the picture — put the
dialogue on a `dialogue` track of the scene, and trim picture and sound
independently.

### Effects

`pva_cut_effects` lists every effect with its parameters, ranges and
defaults — read it rather than guessing a name. In outline:

| picture | |
| --- | --- |
| Light | `exposure`, `brightness`, `contrast`, `gamma`, `curves` |
| Colour | `saturation`, `vibrance`, `temperature`, `tint`, `hue`, `lut`, `monochrome`, `sepia` |
| Lens | `vignette`, `blur`, `sharpen` |
| Texture | `grain`, `denoise` |
| Repair | `deinterlace`, `stabilize` |
| Frame | `crop`, `zoom` (a move from one framing to another), `flip`, `rotate`, `letterbox` |
| Matte | `chroma-key` |

| sound | |
| --- | --- |
| Level | `gain` |
| Tone | `highpass`, `lowpass`, `eq`, `bass`, `treble`, `telephone` |
| Dynamics | `compressor`, `limiter`, `gate`, `normalize` |
| Repair | `denoise`, `deesser` |
| Space | `reverb`, `echo`, `pitch`, `stereo-width`, `pan` |

Where an effect goes decides what it means:

- **on a clip** — that take: repairing it, matching it to its neighbours;
- **on a track** — everything the track carries: a dialogue chain;
- **on the master** — the whole cut: the film's look, the final limiter.

Grade in that order and at the lowest level that is right. A shot is
matched to its scene in the *shot's* cut, so the scene's cut joins shots
that already match; the film's look goes on the *film's* master, once, and
not on every shot. An effect set `"enabled": false` stays in the chain with
its settings, for comparing with and without.

### Layers and titles

A second picture track is drawn over the first: a title card
(`pva_render_graphics`, then a clip of it with `fit: contain`), an insert,
a keyed element (`chroma-key`), a letterbox. Its clips need not be
contiguous. Titles and credits belong to the film's cut; the credits must
carry what `artifacts/score.json` and the footage log's licences require.

## What is a person's

A clip or a track with `locked: true` was locked by a person. Assembly
leaves it exactly as it is; any operation that would change it is refused.
Work around it: that is what the lock asks for. If a locked clip makes the
cut impossible (it overlaps what must go there), stop and say so, with the
clip's id and what is in the way.

A person edits the same `cut.json` in the studio. Their edits arrive as
new revisions. Always read before you write.

## Rendering

`pva_render_cut { film, scene?, shot?, quality }`:

- **Cascades.** A scene's render first renders the shots under it that are
  not current; the film's does the same through scenes to shots. Nothing
  that is current is rendered again, and inside a unit only the windows of
  the timeline that changed are re-encoded. A one-shot change to a feature
  costs that shot, its scene's join and the film's join.
- **`preview`** — at most 960 wide, fast. For timing and structure. A
  preview never becomes the unit's render, and a level above it cannot be
  rendered final from it.
- **`final`** — the film's format. `output/current.json` moves to it only
  when the file is whole.
- **`from` / `to`** (seconds) — part of the timeline, to look at one edit.
- **Blocked** means something under the unit has no current final render
  and could not be rendered: `pva_film` says what and why.

`pva_check_cut` before a final render tells you what it would refuse — a
missing file, an unknown effect, a parameter out of range — without
spending the minutes.

## Reviewing a render

A render that was not looked at is not finished. On the unit:

1. `pva_inspect_media { path: "output/<render-id>.mp4", columns: 6, rows: 6 }`
   — a stamped contact sheet under `artifacts/inspect/`, its measured
   length, frame size and rate, and its loudness. Open the sheet and read
   it frame by frame. For a long film, inspect it in parts (`pva_render_cut`
   with `from` / `to` to look closely at a passage, or more than one sheet).
2. Check, and locate every finding by **timecode**:
   - **Length** — against the cut's, and the film's against
     `runtimeTargetSeconds`.
   - **Picture** — a black or frozen frame where there should be picture; a
     shot that does not match its neighbours (colour, light, a character's
     look); a flash frame at a join; a wrong aspect or unexpected bars;
     lettering or artefacts in generated shots.
   - **Sound** — the measured loudness against the target; a true peak
     over −1 dBTP; silence where the picture has a sound source. Say what
     you could not check: you measured it, you did not hear it.
   - **Text** — titles and credits spelled as the film has them, on screen
     long enough to read.
3. Fix at the level the problem lives: a wrong take in the shot, a late
   cut in the scene, a level in the film's mix. Then render again — only
   what changed will be.

For the film's **Final Review** stage, the record is
`artifacts/film-review.json`:

```json
{
  "render": "final-1794436815513-a3dc4ba1",
  "seconds": 598.4,
  "loudness": { "integrated": -16.1, "truePeak": -1.4, "target": -16 },
  "findings": [
    { "at": "00:03:12:08", "unit": "040-dawn/010-sunrise", "severity": "fix",
      "what": "Two frames of black before the dissolve.", "fixed": true },
    { "at": "00:07:40:00", "unit": "090-roof", "severity": "note",
      "what": "Music enters a beat after the cut; could not judge by ear." }
  ],
  "unchecked": ["How the dialogue sits against the music from 05:10 to 06:30."],
  "verdict": "ready for the person to watch"
}
```

The verdict is never "approved": that is the person's word, asked for with
`pva_request_approval`, with the render's path and this record.
