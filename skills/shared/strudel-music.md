---
name: strudel-music
version: "0.1.0"
description: Write music and designed sound as Strudel code and render it with pva_music_check and pva_music_render — a bed under a voice, a cue, an ambient loop, a sting, one instrument, stems — working from measurements because you cannot hear. Holds what the studio's engine really does where it differs from what Strudel's documentation suggests, and how to mix by numbers. Load it before writing any piece
inputs:
  - name: need
    type: string
    description: What the music is for (the video, its length, its mood, whether a voice speaks over it) and the workspace it lives in
outputs:
  - music/:
      kind: directory
      description: The piece, music/<name>.strudel — the code is the source
  - assets/sounds/:
      kind: directory
      description: The rendered WAV with <file>.music.json beside it (or music/ on a film, assets/audio/ for a scene's sound, assets/music/ for a long ambient version)
capabilities:
  - procedural-music
---

# Music written as code

A piece is a file of [Strudel](https://strudel.cc) code,
`music/<name>.strudel`, in an episode, a channel source or a film unit. You
write and edit it with your file tools. Three tools work on it:

1. `pva_music_check` after **every** edit. It takes two seconds and costs
   nothing: the tempo, what each part plays in each cycle, its notes, and
   what is wrong. `events: 8` lists a part's events — read there what a
   chord or scale expression really produced.
2. `pva_music_render` when it checks clean; `stems: true` on the first mix.
   Read what it returns (below) and change the piece.
3. `pva_music` lists a workspace's pieces and which renders went stale.

**You cannot hear.** Never say how a piece sounds. Say what it is (key,
tempo, form, instruments), what you measured, and what the operator should
listen for. Everything in this skill and in `strudel-sounds` (instruments,
effects) and `strudel-forms` (structure, harmony, kinds of piece) was run on
this engine; what you know of Strudel from elsewhere may not hold here.

## A piece

```strudel
setcpm(96/4)                                  // 96 bpm: one cycle is one 4/4 bar, 2.5 s

kick: s("sbd*2").decay(.2).gain(.4)
bass: note("<a1 f1 c2 g1>").struct("x ~ x x").s("sawtooth").lpf(380).decay(.25).sustain(.2).gain(.45)
keys: n("<[0,2,4] [-2,0,2] [2,4,6] [-1,1,3]>").scale("A3:minor").s("triangle")
  .attack(.02).decay(.4).sustain(.3).release(.4).room(.35).gain(.3).orbit(2)
```

- Each **labelled statement is a part**: what `only`, `mute` and `stems`
  name. Label everything. A label is a JavaScript one: letters, digits and
  `_`, no dash. `_keys:` mutes a part in the code. **A label that starts
  with a capital S solos its part** (`Strings:`, `Sub:`) and silences the
  rest: start labels in lower case.
- `const` and small functions are fine; so are comments.
- Tempo: `setcpm(bpm/4)`. Without it a cycle is 2 s.

## What the engine has

Oscillators and noise, nothing else: `sine`, `triangle`, `square`,
`sawtooth`, `supersaw`, `pulse`, `user` (your own harmonics), `sbd` (a
synthetic kick), `white`, `pink`, `brown`, `crackle`, `bytebeat`, the `z_*`
game sounds. **There is no `bd`, `sd`, `hh`, `piano`, `gm_*`, no
`.bank()`**: those are sample packs on other people's servers and the
network is off. Drums, basses, keys and pads are built from the above:
`strudel-sounds` has them, tested.

A recording in the workspace can be an instrument — in single quotes, by
its path:

```strudel
samples({ rain: 'assets/sounds/rain.wav' })
bed: s("rain").loopAt(4).lpf(3000).gain(.5)
hits: s("rain").slice(8, "0 ~ 5 ~").speed("<1 -1>").clip(1).room(.4).gain(.6).orbit(2)
```

A sample plays to its own end unless `.clip(1)` stops it with its event.
`begin`/`end` (0–1) choose a stretch, `speed` its pitch (negative plays it
backwards), `loopAt(n)` fits it to n cycles, `chop(n)` and `slice(n, "…")`
cut it up, `cut(1)` lets a new hit stop the last. The render records which
files a piece loaded. A pack from the network needs `network: true` and a
licence you checked: ask the operator first.

## What differs from what you would assume

Each of these was measured.

**Text**
- A string in `"double quotes"` or `` `backticks` `` is always a pattern,
  even handed to your own function. Plain text is in `'single quotes'`: a
  path in `samples()`, an argument of a helper. Given to a Strudel function,
  single quotes are mini-notation too; literal text for a control is
  `pure('…')`.

**Pitch**
- `c3` is MIDI 48, 131 Hz; `a4` is 440. A note with no `s` plays `triangle`.
- **`n` is not a pitch until `.scale()` follows it** (alone it is a harmonic
  count or a detune). `n("0 2 4").scale("C4:minor")`: 0 is the root; with no
  octave the root is in octave 3. `chord("Am7")` plays nothing until
  `.voicing()`.
- **A wrong name is silence, not an error.** Scales take colons —
  `"C:minor"`, `"A2:minor:pentatonic"`; `"C minor"`, `"C:min"`, `"C:maj"`
  lose notes or all of them. Chords: `Cmaj7`, `Cdim`, `Csus4`, `Csus2` and
  a lower-case root play nothing; write `C^7`, `Co`, `Csus` (`strudel-forms`
  lists the symbols that work). After writing harmony, check that **every
  cycle has events**.
- `.add("<0 3>")` after `n(…)` or `note(…)` changes nothing: add inside,
  `n("0,2,4".add("<0 3 4 5>"))`, or add a `note(…)`.

**Level** — there is no limiter and no compressor: parts add.
- The default `gain` is .8. One oscillator note peaks near −12 dBFS;
  **`sbd` is 10 dB hotter** (`gain(.4–.6)`); `pink` is 13 LU under `white`,
  `brown` 25.
- Chords add: three notes are +7 dB of peak, six +11. A four-note pad wants
  `gain(.25–.4)`.
- **What starts on the same sample adds at its peak**: a kick at −5.9 dBFS,
  a bass at −13.7 and a chord at −16.6 peak at −3.1 together. The piece's
  highest peak is where most parts meet, usually beat 1.
- `gain`, `postgain` and `velocity` are plain factors: half is −6 dB. A
  later `.gain()` **replaces** an earlier one, also inside a `stack`: scale
  a stack, or every part with `all(x => x.postgain(.7))`, by `postgain`.
- Any `.pan()` costs 3 dB. `distort`, `shape`, a resonant `lpq` and
  `compressor` all add level: `distort("2:.3")` — amount, then the level
  to come out at.

**Envelope**
- With nothing written a note is: 1 ms attack, 50 ms decay to a sustain of
  .6, 10 ms release. Writing **only `attack` or only `release` makes the
  note 4.4 dB louder** (its sustain becomes 1). `decay` alone is a pluck
  (sustain 0).
- **A decay stops where its event ends.** A bell on eighth notes is a short
  note unless it has a `release` to ring in: `decay(2).sustain(0).release(1.5)`.
  Only `sbd` rings for its whole `decay`, whatever its event's length.
- The amplitude envelope is linear: a 1 s decay is gone at 1.0 s sharp.
  Filter and FM envelopes are exponential.
- `clip(.5)` halves a note's length; `legato` is the same.

**Movement**
- A signal on a control — `lpf(sine.range(300, 2000).slow(8))`, `pan(sine)`,
  `gain(saw)` — **is read once per event**. On short notes that is a sweep.
  On a held note nothing moves: use `lpenv` with `lpattack`, `lprate` with
  `lpdepth` (an LFO in Hz), `vib`, `tremolo`, or `.lfo({…})` / `.env({…})`
  after the control.

**Space**
- **An orbit has one reverb and one delay.** Parts that ask it for
  different `rsize`, or a different `delaytime` or `delayfeedback`, cut each
  other's tails, and the check warns. Give them the same values — an
  `rsize` written on one part serves those that write none; a `delay` with
  no time asks for the default — or each its own `.orbit(2)`, `.orbit(3)`…
- `room` is the amount; the length is `.rsize(seconds)`, 2 by default.
  `room(".5:4")` does not set it. A reverb rings about 0.6 × `rsize`
  seconds after the sound: that is the `tail` to ask for.
- `delaytime` is in **seconds**, `delaysync` in **cycles** (`delaysync(1/8)`
  is an eighth when a cycle is a bar). The default is 3/16 of a cycle.
  `delayfeedback(0)` removes the delay altogether.
- Sidechain: `.duckorbit(2).duckdepth(.5).duckattack(.2)` on the kick dips
  everything on orbit 2 by 10 dB at each hit. The ducked parts must be on
  that orbit and the kick on another.
- Width that survives mono (correlation .7–.85): a different `.pan()` for
  each part, `.pan(sine.range(.2, .8).slow(2))` on a run of notes,
  `.juxBy(.5, rev)`, a reverb, `supersaw` as it comes. Too wide (about 0):
  `jux` in full, `spread(1)`, a detuned or delayed copy on one side. The
  delay is mono. Two noise events are the same samples, so noise panned
  apart stays mono: an ambience gets its width from
  `.jux(x => x.late(.013))`, which is wide on purpose.

**Things that do nothing, silently**
- `chorus`, `squiz`, `accelerate`, `leslie`, `comb`, `ring`, `nudge` and
  every MIDI control exist and change nothing here; `cut` only acts on
  samples; there is no glide between notes. `pva_music_check` names the
  ones it finds. `crush(1)` and `crush(2)` render silence. `compressor` is
  not a limiter: it works on each note and makes the mix louder.
- These do not exist: `seqP`, `ur`, `whenmod`, `while`, `sew`, `stitch`,
  `fix`, `rot`, `humanize`, `rolled`, `arpeggiate`, `once`, `euclidOff`,
  and `fadeIn`/`fadeOut` on a pattern (a fade is the render's).

**Chance**
- `rand`, `irand`, `perlin`, `degradeBy`, `sometimes`, `?` give the same
  result on every render and **never repeat from cycle to cycle**. In a
  loop, close them with `.ribbon(7, 8)`: eight cycles of the random
  pattern, again and again. Not from 0 — at cycle 0 the random number is
  exactly 0, so the first event is always the one dropped.
- Two random functions at the same instant draw the same number:
  `n(irand(6).segment(4)).degradeBy(.7)` keeps only the highest notes. Give
  one its own draw: `irand(6).seed(41)`.
- The tool's `seed` changes the noise and the detune, not the notes.

**Time**
- `late(x)` and `early(x)` are in cycles: 15 ms is `.015 × cps`. Apply
  `struct` before them, or it puts everything back on the grid.

## Seconds and cycles

`seconds = cycles × 240 / bpm` when a cycle is a 4/4 bar. For a piece of an
exact length choose the bars, then the tempo:
`setcpm(bars * 60 / seconds)` — 12 bars in 30 s is `setcpm(24)`, 96 bpm.
`pva_music_render` with `seconds` takes as many whole cycles as fit;
`cycles` takes fractions too.

An event that must fall on a timecode is put on the cycle that lands there:
at 96 bpm second 12.5 is the start of cycle 5.

## Rendering what is needed

One piece gives every version of itself — do not write a second piece for
a variant.

| For | Ask |
| --- | --- |
| A piece that ends | `cycles`, and a `tail` for its last notes and reverb to ring out |
| A bed to repeat under a scene of any length | `loop: true` with a `tail` (it is folded over the start); repeat the file in the edit |
| A long ambient version (hours) | two or more pieces of a minute or more, with tails, to `assets/music/` — `pva_extend_episode` strings them together. No stems there: every audio file in that folder is taken as a piece |
| One section | `from`, `cycles`; `lead: 1` to open with what rang before it |
| One instrument, or the piece without one | `only: ["bass"]`, `mute: ["lead"]` |
| Stems for the cut to mix | `stems: true` |
| A sound effect | its part alone (`only`), a few cycles, a `tail`, `output: "assets/audio/…"` |
| A sound the next one cuts (a riser into a hit) | `tail: 0`; the render then says it is still sounding where it ends, which is what was asked |
| Another take of the same notes | `seed` |

`from`, `cycles` and `lead` are cycles; `tail`, `fadeIn` and `fadeOut` are
seconds. A file is brought to −18 LUFS with one gain, its peaks kept under
−1 dBFS (`loudness`, `peak`; `loudness: null` keeps its own level, as a
one-shot effect usually should). Rendering runs several times faster than
the music; a render holds 15 minutes at most.

## Mixing by numbers

`pva_music_render` returns, for the file: its loudness, its peak and when
it falls, the share of the energy in six bands, the centroid, the crest,
the stereo correlation and width, and the level through time; and for each
stem its loudness, peak, crest, strongest bands, centroid and correlation.
Read them as a person would listen. The bands: `sub` under 60 Hz, `bass`
60–250, `low-mid` 250–500, `mid` 500–2000, `high-mid` 2–6 kHz, `high`
above.

**Headroom.** Nothing limits the engine, and what goes over 0 dBFS clips
when a person plays the piece in the studio — the render's gain hides it in
the file. The render prints the peak the piece itself has: keep it under 0
with a few dB to spare. One line does it, the master fader:
`all(x => x.postgain(k))`, k = 10^(dB / 20), so 3 dB down is .7 — and then
no part uses `postgain` itself.

**Loudness.** The file is then brought to −18 LUFS as far as the −1 dBFS
ceiling allows. Music with drums peaks 15–18 dB over its loudness and can
land up to 1 dB under: the edit sets the level anyway. A render 3 dB or more
short says so, with the second and the cycle of its highest peak. Look at
what meets there (`pva_music_check` with `from` that cycle, `cycles: 1`,
`events: 8`; the stems' peaks say which part is hardest): lower that part,
move an accent off that beat, or give a bass or a chord that starts with
the kick `attack(.03)` — 1 dB.

**Balance, by the stems' loudness** (LUFS; what held across the tested
pieces in `strudel-forms`):

| Against the kick | is under it by |
| --- | --- |
| bass | 3–5 dB |
| the main harmonic part (pad, keys, plucks) | 3–9 dB |
| a lead | 4–9 dB |
| clap, snare | 7–14 dB |
| hi-hats | 12–15 dB |
| shakers, textures | 18 dB or more |

With no drums, set the others against the main instrument: bass about 3 dB
under it, a pad or a top line 5–6 under. Under a voice the kick comes down:
in the tested bed it is 2 dB under the bass and level with the pad.

**Spectrum** (share of the energy per band, as the render prints it):

- A full piece with kick and bass: `bass` is the largest band (−1.5 to
  −2.5), `sub` −11 to −13, `low-mid` −5 to −10, `mid` −9 to −15, `high-mid`
  −18 to −22, `high` −17 to −23; centroid 300–500 Hz; crest 18–20 dB. A
  sustained piece without drums has a crest of 13–15.
- **Muddy or dull**: `low-mid` more than 20 dB above `high-mid`, `high-mid`
  under −27, centroid under 270 Hz — and, when it is mud, the pad's stem
  louder than everything. Lower the pad, raise it an octave or open its
  `lpf`; give the plucks or the hats back their top.
- **Harsh**: `high-mid` above −14 and `high` above −16 with a centroid near
  800 Hz in a piece that has kick and bass. Find the stem that carries the
  band and darken it (`lpf`), shorten it or lower it.
- A piece led by a mallet or a bright chord reads like the harsh one on
  purpose: the shares cannot tell which. Say which stem carries the top and
  let the operator judge.
- A `sub` share above about −6 is a piece a phone will not play: raise the
  kick's and the bass's notes into 60–120 Hz.

**Stereo.** A mix's correlation of .85–1 is normal — kick and bass are in
the middle. Judge width on the stems: a stem at .3 or under is too wide
(`jux` in full, `spread(1)`): use `juxBy(.5, …)`, a lower `spread`, or
`.pan(sine.range(.2, .8).slow(2))`. Below 0 it cancels in mono, and the
render says so.

**The level through time** is the piece's shape. Windows that fall to −50
between notes are notes cut short: `clip(2)` or a longer `release`. A build
shows as a rise, a section as a step: a flat line where a build was meant
is a ramp on a held note. A loop is checked for you: the render compares
what each part plays in the loop's cycles and in the next ones, and names
the parts that do not come round.

**Under a voice** a bed measures: `high-mid` share at −35 or under, `mid` at
−14 or under, centroid under 200 Hz, the level through time within 3–4 dB,
no melody above `c5`, attacks of 15 ms or more, a kick low-passed under
200 Hz or none. `strudel-forms` has two tested beds and how they were got.

**Ducking and stems.** A stem is its part alone: a pad ducked by the kick
is not ducked in its stem. The stems of noise, `supersaw` and reverb sound
like their parts without being the same samples as in the mix: mix from
stems, never stems with the mix.

## In an edit

- **An episode with a spec**: a render in `assets/sounds/<name>.wav` is the
  sound `<name>` its spec names. The record is `<name>.wav.music.json`.
- **A film**: cues live in `music/` on the film (`series: "_"`,
  `episode: "_"`) and go on the cut's `music` track; a scene's designed
  sounds in `assets/audio/`. `film-sound` has the spotting and the levels.
- **Under a voice** the edit sets the level, not the piece: 15–20 dB under
  narration, or ducked 6–12 dB while someone speaks (`audio-editing`,
  `film-sound`).

## Never

- Never say a piece sounds good, or right: say what was measured.
- Never leave a concern of a render unread: it is what the operator would
  have heard.
- Never fetch a sample pack without the operator's word; never present a
  synthesizer as an orchestra.
- Never edit a rendered file to fix the music: change the piece and render
  again. The code is the source.
