---
name: strudel-forms
version: "0.1.0"
description: Give a piece of Strudel music its shape — sections of exact lengths, parts that enter and leave, harmony and melody from one progression, a build, an ending or a seamless loop, an event on a timecode — and start from a tested whole piece for the job: a bed under a voice, an ambient loop, an explainer underscore, a tension build, a sting, a sixty-second arc. Load strudel-music first
inputs:
  - name: need
    type: string
    description: The kind of piece, its length, where it must change, and whether it ends or loops
outputs:
  - music/:
      kind: directory
      description: The piece, music/<name>.strudel
capabilities:
  - procedural-music
---

# The shape of a piece

Everything here was run on the studio's engine; the tests evaluate and
render every block and every example again.

## Start from a whole piece

Beside this skill, in `examples/` (under `.pi/skills/strudel-forms/` or
`.claude/skills/strudel-forms/`), are complete pieces that check clean and
were mixed by their stems. **Copy the nearest one to `music/<name>.strudel`
and change it** — key, tempo, form, instruments — rather than starting from
nothing. Each begins with what it is and how to render it.

| File | What | Tempo, length |
| --- | --- | --- |
| `examples/explainer-under-voice.strudel` | A light, positive bed built to sit **under narration**; loops every 8 bars | 110 bpm, 17.5 s loop |
| `examples/explainer.strudel` | The same music on its own: intro, A, B, a final chord | 110 bpm, 52 s |
| `examples/ambient-under-voice.strudel` | Drone, dark pad, rare low bells, **under narration**; a seamless loop | 60 bpm, 64 s loop |
| `examples/ambient-loop.strudel` | Calm ambient with no percussion: drone, pad, sparse bells, air | 60 bpm, 64 s loop |
| `examples/tension-build.strudel` | A low pulse and rising elements with no melody, into an impact | 100 bpm, 50 s |
| `examples/emotional-keys.strudel` | A slow broken-chord keys part with a pad, ending on a held chord | 72 bpm, 53 s |
| `examples/lofi-beat.strudel` | A swung, dark chill beat with a late melody | 80 bpm, 48 s loop |
| `examples/uptempo-montage.strudel` | Four-on-the-floor with a break, a riser and a peak, ducked by its kick | 128 bpm, 60 s |
| `examples/playful-tune.strudel` | A bouncy staccato tune for children's content, with a "ta-da" | 120 bpm, 34 s |
| `examples/sixty-seconds.strudel` | Intro, build, peak, outro and a real ending in exactly a minute | 120 bpm, 60 s |
| `examples/logo-sting.strudel` | A one-second run into a chord that rings | 5 s |
| `examples/form-template.strudel` | Thirty-two bars with five parts entering and leaving: the bare mechanism | 120 bpm, 64 s |

## Sections of exact lengths

A form is one line: a letter for each section and its length in cycles.
Three helpers read it.

```strudel
// render: cycles 24, tail 2 = 50 s
setcpm(120/4)                                   // one cycle = one bar = 2 s
const letters = ['i', 'a', 'b', 'o']
const form = "<i@4 a@8 b@8 o@4>"                // intro 4 bars, A 8, B 8, outro 4: 24 bars, 48 s
const inSec = (names) => form.fmap((x) => names.split(' ').includes(x))
const only = (table) => form.pickRestart(Object.assign(Object.fromEntries(letters.map((l) => [l, silence])), table))
const sect = (table) => form.pickRestart(table)
const prog = "<C G Am F>"

pad: chord(prog).anchor("g4").voicing().s("sawtooth")
  .lpf(sect({ i: 500, a: 900, b: saw.rangex(900, 2400).slow(8), o: 700 }))
  .attack(.4).release(.8).gain(.14)
bass: prog.rootNotes(2).note().struct("x ~ ~ x ~ ~ x ~").s("triangle").lpf(500).decay(.3).sustain(.4).gain(.6)
  .mask(inSec('a b'))
kick: only({ a: s("sbd ~ sbd ~"), b: s("sbd*4") }).decay(.22).gain(.45)
riser: only({ a: s("white").slow(2).mask("<0!6 1!2>").lpf(300).lpenv(5.5).lpattack(3.9).attack(3.9).release(.05).gain(.3) })
all(x => x.postgain(sect({ i: .5, a: .6, b: .7, o: .5 })))
```

- **`.mask(inSec('a b'))`** — the part plays in those sections and is
  silent in the others. The simplest tool: use it for a part that is the
  same wherever it plays.
- **`only({ a: …, b: … })`** — different material per section, silence
  elsewhere, and each pattern **starts over at its section's first bar**.
  That restart is what a long single event needs (the riser: one 2-bar
  event placed in the section's last two bars) and what a ramp needs.
- **`sect({ … })`** — a value per section for a control, every letter
  given. A signal there runs from the section's start:
  `saw.rangex(900, 2400).slow(8)` opens the filter across the 8 bars of B.
- **`all(x => x.postgain(sect({ … })))`** — the piece's dynamics in one
  line: every part, section by section. Parts then use `gain` only.
- **Every letter of the form must be a key** of a `sect` or a `pick`. One
  missing key silences the whole piece, not the part; the check says so.
  `only` fills the missing ones with silence.
- In a form, `a@8` is one section eight bars long. Inside a pattern it
  stretches: `<x@2 y@2>` plays x and y at half speed. For "each bar twice"
  write `<x!2 y!2>`.
- **A mask never starts a note.** A hit wanted once, on one beat, is a
  `struct`: `.struct("<~ ~ ~ [~ ~ ~ x]>")` is the last beat of every fourth
  bar. And a long event made with `.slow(8)` starts on bars 0, 8, 16… of the
  piece, whatever section it is in: place it with `only`.
- Check the form with `pva_music_check` over the whole length
  (`cycles: 24`): each part's events per cycle show where it is silent.

## Harmony from one line

Write the progression once, as chord symbols, and derive every part from it.

```strudel
setcpm(100/4)
const prog = "<Am9 F^7 C^9 G6>"                  // one chord per bar; "<…>/2" for one every two bars

pad: chord(prog).anchor("a4").voicing().s("sawtooth").lpf(700).attack(.8).release(1.5).gain(.12)
bass: prog.rootNotes(2).note().s("sine").attack(.02).decay(.6).sustain(.7).release(.15).gain(.5)
arp: n("0 2 1 3 2 4 3 1").chord(prog).anchor("e5").voicing().s("triangle").decay(.4).sustain(0).release(.4).gain(.4)
tune: n("<[~ ~ 4 ~] [~ 2 ~ ~] [~ ~ 3 4] [1 ~ ~ ~]>").scale("A4:minor").s("sine").decay(.8).sustain(.1).release(.8).gain(.35)
```

- `chord(prog).voicing()` is the chord; `.anchor("a4")` sets the note the
  voicing stays under, so chords move smoothly in one register.
- `prog.rootNotes(2).note()` is the bass: each chord's root in octave 2.
- `n("0 2 1 3").chord(prog).voicing()` plays the chord's own notes by
  number: an arpeggio that follows the harmony.
- A melody is scale steps: `n(…).scale("A4:minor")`. Rests are `~`.
- Symbols that give notes: `C` `Cm` `C7` `Cm7` `C^7` (major seventh) `C6`
  `Cm6` `C9` `Cm9` `C^9` `Cadd9` `C69` `Csus` `C7sus` `C5` `C2` `Co` `Co7`
  `Cm7b5` `Caug` `C11` `C13` `C7b9` `C7#9`. **Silent, with no error:**
  `Cmaj7`, `Cdim`, `Csus4`, `Csus2`, a lower-case root. `.dict("triads")`
  gives three-note chords, and is silent on a seventh.
- The other way is scale steps, with one line of degrees for every part:
  `const deg = "<0 0 5 6>"`, then `n("0,2,4".add(deg)).scale("D3:minor")`
  for the chord and `n(deg).scale("D2:minor")` for the bass
  (`examples/uptempo-montage.strudel`).
- After writing harmony, `pva_music_check` over the whole progression: a
  bar with no events is a name the engine did not know.

## A build

A signal on a control is read once per event (`strudel-music`), so a ramp
works on parts that play many notes, and not on a held one.

- Across a section: a `sect` value, as above.
- Across the piece: `const build = saw.slow(20)` rises from 0 to 1 over 20
  bars; `.lpf(build.rangex(220, 1800))` and `.velocity(build.range(.5, 1))`
  open and lift every part that uses them (`examples/tension-build.strudel`).
- Inside one long event (a riser, a swell): its own envelope —
  `lpenv` with `lpattack`, `attack` — placed with `only`.
- Adding parts is the plainest build: more sections in each `inSec`.

## An ending, or a loop

**A piece that ends** has a last section holding one chord, with a long
`decay` and `release`, and is rendered with a `tail` for it to ring in:
`examples/sixty-seconds.strudel` (`cycles: 28, tail: 4` is 60.0 s),
`examples/explainer.strudel`. Without it a render stops mid-phrase and its
record says so.

**A loop** is rendered with `loop: true` and a `tail`. It is seamless only
when every part repeats within its length:

- an alternation `<a b c d>` repeats every 4 cycles, `<…>/2` every 8: the
  loop's length must be a multiple of every one of them;
- chance does not repeat: close it, `.degradeBy(.7).ribbon(7, 8)` plays
  cycles 7–14 of the random pattern for ever (not from 0: `strudel-music`
  says why);
- nothing ends on a hard chord: the loop's last bar leads into its first.

## An event on a timecode

Seconds = cycles × 240 / bpm, and a render starts exactly on cycle 0:
events land on their sample. To put a hit at 48.0 s at 100 bpm (2.4 s a
bar) it goes on bar 20, a section of its own in the form
(`"<i@4 a@4 b@4 c@8 x>"`, `only({ x: … })`). When the time is fixed and the
bars are not, choose the tempo: `setcpm(bars × 60 / seconds)` — 20 bars in
47.5 s is `setcpm(20 * 60 / 47.5)`. A riser ends where the hit starts: it
is the last event of the section before.

## Under a voice

Compare `examples/explainer.strudel` with
`examples/explainer-under-voice.strudel`: the second is the first, changed
to leave the voice its room.

- **No melody**, and nothing that moves in 1–4 kHz, where speech is
  understood. What put energy there was the plucked and bell parts, not the
  pad: the bells and the clap go, the arpeggio drops an octave and half its
  notes. This is what changes most.
- **Darker**: pad `lpf` 900 → 450, the plucks' filter capped near 1.7 kHz.
  (High-passing the pad at 300 Hz did nothing for the voice.)
- **Softer**: attacks of 15 ms and up, a sine bass, the kick halved and
  low-passed at 180 Hz.
- **A flat level**: no build, no drops — the edit sets how loud it is.
- **Air above the voice is fine**: a quiet shaker over 9 kHz keeps it alive.
- **A loop**, so it fits any length of narration.

The result: 1–4 kHz sits 28 dB under the bed's own level (17 dB in the full
version); in the ambient pair, 35 dB against 13. No single change was worth
more than 2 dB: it takes all of them.

## Movement that sounds played

Verified idioms, all in the examples:

- an accent pattern on `gain`: `.gain("[.9 .6]*4")`;
- swing: `.swingBy(1/3, 4)`; a lazy note: `.late("[0 .01 0 .015]")` (cycles);
- an uneven touch: `.velocity(perlin.range(.6, 1))`;
- a few dropped hits, the same every bar-group: `.degradeBy(.15).ribbon(3, 4)`;
- a note held into the next: `.clip(2.5)`;
- an echo an octave up: `.off(1/8, x => x.add(n(7)).gain(.5))` before `.scale`;
- a Euclidean tick: `s("white(5,16,<0 2>)")`.
