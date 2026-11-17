---
name: strudel-sounds
version: "0.1.0"
description: Tested instruments and designed sounds for music written as Strudel code — drums, basses, pads, keys, leads, ambiences, risers, impacts, whooshes, interface sounds — each a part that evaluates and was measured on the studio's engine, with the controls that change it. Load it when a piece needs a sound; load strudel-music first
inputs:
  - name: need
    type: string
    description: The instrument or the sound wanted, and the piece it goes in
outputs:
  - music/:
      kind: directory
      description: The piece (music/<name>.strudel) the part is written into
capabilities:
  - procedural-music
---

# Sounds for Strudel pieces

Every part below was rendered on the studio's engine (Strudel 1.3.0) and
measured; the tests evaluate each block again. They are built only from the
engine's own sources — `sine`, `triangle`, `square`, `sawtooth`, `supersaw`,
`pulse`, `user`, `sbd`, `white`, `pink`, `brown`, `crackle`, `bytebeat`, the
`z_*` family — because nothing else is there (`strudel-music` says why).

Copy a part into a piece under its own label and re-tune it: the comment
says which control moves what. Each block is a catalogue played at once, not
a mix. In a piece, parts on one orbit share its reverb and its delay
(`strudel-music`, Space).

Levels as written: sustained parts sit near −18 LUFS and peak under −6 dBFS
alone. Check the mix after adding one (`pva_music_render`, `stems: true`).

## Drums

```strudel
setcpm(120/4)
kick: s("sbd ~ ~ sbd ~ sbd ~ ~").decay(.2).pdecay(.15).penv(30).gain(.5)
snare: stack(note("g3").s("triangle").penv(12).pdecay(.04).decay(.12).gain(.9), s("white").hpf(1500).lpf(9000).decay(.17).gain(.7)).struct("~ x ~ x").postgain(.75)
clap: s("white").struct("~ ~ ~ [~ x]").bpf(1200).bpq(1.5).decay(.008).gain(3).layer(x=>x, x=>x.late(.0075), x=>x.late(.015), x=>x.late(.0225).decay(.18).gain(2))
hat: s("white*8").hpf(8000).decay(.04).gain("[.45 .25]*4")
openhat: s("white").struct("~ ~ ~ ~ ~ ~ ~ x").hpf(7000).decay(.3).gain(.3)
shaker: s("white*16").bpf(6000).bpq(1).attack(.015).decay(.05).gain("[.8 .35 .55 .35]*4")
ride: freq("[205.3,304.4,369.6,522.7,540,800]").s("square").struct("x ~ x x").bpf(5200).bpq(.7).hpf(3000).decay(.5).gain(.22)
tom: note("<~ ~ ~ [~ ~ g2 e2]>").s("sine").penv(7).pdecay(.12).decay(.3).gain(.8)
rim: freq("[430,1740]").s("square").struct("<~ [~ x ~ ~ ~ ~ x ~]>").decay(.035).hpf(400).gain(.35)
```

This kit is balanced: peaks kick −6, snare −9, rim −10, clap −11, tom −12,
hats and shaker −14 to −17, ride −17 dBFS; the mix −18 LUFS, peak −3 dBFS.

- **kick** (`sbd`): `decay` is its length (exponential; .2 tight, 1.2 an 808
  boom — then one per bar, tails add). `pdecay` shorter = more thud, less
  "pew". `penv` = sweep depth in semitones. `note("g1")` tunes the body
  (default about 45 Hz). `sbd` ignores `attack`, `sustain`, `release`, and
  rings for its whole `decay` past the end of its event.
- **snare**: a pitched body plus noise. The two inner `gain`s are the
  balance; scale the whole with `postgain`. Noise `lpf` 5000–9000 = dark to
  bright.
- **clap**: four bursts, each `late` by 7.5 ms more — in cycles, so these
  values are for 120 bpm (`strudel-music`, Time).
- **hats**: `decay` .02–.08 closed, .3 open; `hpf` 4000–10000 = body. There
  is no choke. Two noise parts on one step add 6 dB: every noise hit is the
  same waveform.
- **ride / metal hat**: six inharmonic squares; `bpf` 3500–5200 = pitch of
  the ping, `decay` 1+ = a wash. For a crash: `s("white").hpf(4000).decay(1.5)`.
- Softer kit for a quiet bed: the kick below, and
  `s("pink*8").bpf(3000).bpq(.7).attack(.008).decay(.06).gain("[2 1.2]*4")`
  for a brush tick (−33 LUFS by design).

```strudel
setcpm(90/4)
softkick: note("f1*2").s("sine").penv(18).pdecay(.06).attack(.004).decay(.3).sustain(0).gain(1)
softsnare: note("g3").s("triangle").noise(.8).penv(12).pdecay(.04).decay(.15).hpf(180).gain(1.6).struct("~ x ~ x")
clave: freq(2500).s("sine").decay(.07).struct("x ~ x [~ x] ~ x x ~").gain(.5)
```

## Bass

`c2` is 65 Hz. Under 60 Hz a phone or a laptop plays nothing: a bass whose
energy is all in the `sub` band measures fine and is not heard. Keep the
fundamental in 60–120 Hz or give it harmonics (`round`, `fm`, `pluck`).

```strudel
setcpm(100/4)
sub: note("c2 c2 g1 bb1").s("sine").attack(.01).release(.05).gain(.7)
round: note("c2 c2 g1 bb1").s("triangle").lpf(400).lpenv(2).lpdecay(.2).decay(.4).sustain(.3).release(.08).gain(1.2)
pluck: note("c2 c2 g1 bb1").s("sawtooth").lpf(250).lpenv(4).lpdecay(.15).decay(.35).sustain(0).gain(1.2)
fm: note("c2 c2 g1 bb1").s("sine").fm(2).fmdecay(.12).decay(.45).sustain(0).gain(1.1)
saw: note("c2 c2 g1 bb1").s("sawtooth").lpf(300).lpenv(3).lpdecay(.2).lpsustain(.2).decay(.1).sustain(.7).release(.08)
acid: note("c2 c3 c2 eb2 c2 c2 bb1 c3").s("sawtooth").ftype("24db").lpf(300).lpq(10).lpenv(4).lpdecay(.12).lpsustain(0).decay(.2).sustain(.3).clip(.8).gain(.6)
reese: note("c1 c1 g1 bb1").s("supersaw").unison(3).detune(.4).spread(.3).lpf(500).attack(.02).release(.08).gain(1)
```

- `lpenv` (octaves above `lpf`) is the bite, `lpdecay` how long it stays
  open; `lpf` 200–500 the darkness.
- `sub`: keep `release` ≤ .05 — longer, and legato notes add up to 6 dB at
  each join.
- `acid`: on `ftype("24db")` keep `lpq` ≤ 10 (20 measured +19 dB and
  clips); on the default filter 15–20. There is no slide between notes.
- `reese`: `detune` .2–.8 = beat rate; `spread(0)` for a strictly mono bass.

## Pads and sustained sounds

```strudel
setcpm(60/4)
warm: note("<[c3,eb3,g3,bb3] [ab2,c3,eb3,g3]>").s("supersaw").lpf(1400).attack(.6).release(1.5).room(.4).rsize(4).gain(.4)
soft: note("<[c3,eb3,g3,bb3] [ab2,c3,eb3,g3]>").add(note("0,.1")).s("triangle").lpf(2000).attack(1).release(2).room(.4).rsize(4).gain(.22)
glass: note("<[c4,eb4,g4,bb4] [ab3,c4,eb4,g4]>").s("sine").fm(1.2).fmh(2.005).fmattack(1.5).attack(.4).release(2).room(.5).rsize(4).gain(.23)
strings: note("<[c3,g3,eb4,bb4] [ab2,eb3,c4,g4]>").s("supersaw").unison(7).detune(.3).hpf(180).lpf(3500).vib("5.5:.12").attack(.18).release(.5).room(.3).rsize(4).gain(.36)
```

- `warm`: `lpf` 400 / 800 / 1600 / 3200 moves the centroid 209 / 289 / 360 /
  416 Hz — the one control for how present it is. Width comes from
  `spread` (default .6).
- `soft`: two triangles 0.1 semitone apart; 98 % of its energy is in
  60–250 Hz, the most unobtrusive pad under a voice.
- `glass`: `fm` .5–2 = glassiness; use the 4th octave, lower gets muddy.
- `strings`: an ensemble, not a string section. `attack` .1–.3 = bowing.
- A pad with a filter that opens (`lpattack`) and a long `release` goes dull
  the instant the note ends unless `lprelease` is about the `release`.

```strudel
setcpm(30/4)
drone: note("[c2,g2,c3]").s("sawtooth").lpf(500).lprate(.1).lpdepth(1.4).attack(2).release(3).room(.5).rsize(6).gain(.5)
tension: stack(note("[c2,db2,g2]").s("sawtooth").lpf(350).lprate(.07).lpdepth(1.2).gain(.4), note("b5").s("sine").vib(".3:.4").tremolo(".2:.7").tremoloshape("sine").gain(.08)).attack(3).release(4).room(.6).rsize(8).orbit(2)
organ: note("<[c3,g3,c4,e4] [f3,a3,c4,f4]>").s("user").partials([1,.8,.6,.5,0,.3,0,.25]).attack(.005).release(.06).tremolo("6:.25").tremoloshape("sine").lpf(5000).gain(.4)
```

- `drone`: one event per cycle, 8 s here; `lprate` (Hz) and `lpdepth` move
  the filter inside the note. `tension` is the same with a minor second and
  a faint high sine: raise that sine's `gain` for more unease.
- `organ`: `partials([...])` are drawbars (harmonic 1, 2, 3…).

## Keys, plucks, tuned percussion

```strudel
setcpm(100/4)
epiano: note("<[c3,g3,bb3,eb4] [f3,a3,c4,e4]>*2").s("sine").fm(1.4).fmdecay(.5).fmsustain(.15).fm20(.5).fmh2(14).fmdecay2(.06).decay(1.6).sustain(0).release(.3).gain(.35)
softpiano: note("<[c3,g3,eb4] [ab2,eb3,c4]> [g4 eb4] <bb3 c4> g3").layer(x=>x.s("triangle").decay(2.5).gain(.45), x=>x.s("sawtooth").lpf(600).lpenv(3).lpdecay(.25).decay(.6).gain(.2)).sustain(0).release(.4)
pluck: n("0 2 4 7 4 2 0 -3").scale("C3:minor").s("sawtooth").lpf(400).lpenv(4).lpdecay(.25).decay(.9).sustain(0).release(.4).gain(.65)
marimba: n("0 2 4 7 4 2 0 -3").scale("C4:major:pentatonic").s("sine").fm(1.2).fmh(4).fmdecay(.06).decay(.35).sustain(0).release(.3).gain(.65)
```

```strudel
setcpm(100/4)
bell: note("c5 g4 eb5 bb4").s("sine").fm(3).fmh(3.5).fmdecay(1.2).decay(2.5).sustain(0).release(2).room(.4).rsize(4).gain(.32)
glock: n("0 4 7 4 9 7 4 2").scale("C6:major").s("sine").fm(1.5).fmh(5.4).fmdecay(.15).decay(.9).sustain(0).release(.9).gain(.32)
```

- The shape of all of these is `decay(d).sustain(0).release(…)`: the
  `release` is what lets a short note ring.
- `epiano`: `fm` = bark; `fm20(.5).fmh2(14).fmdecay2(.06)` is the tine (a
  second operator straight into the carrier, for 60 ms).
- `softpiano` is a mellow electric piano, not a piano: no hammer, no
  string. Say so when a brief asks for a piano.
- `pluck`: `lpdecay` is the damping (.1 muted, .5 open).
- `marimba`: kalimba with `fmh(6.3).decay(.6)`. `glock`: a music box at
  `C5` with `decay(.5)`. `bell`: a non-integer `fmh` (3.5) is what makes it
  a bell; `fm` 2–5 = brightness.

## Leads

```strudel
setcpm(100/4)
softlead: n("0 2 4 [7 4] 2 ~ 0 ~").scale("C5:minor").s("triangle").vib("5:.2").attack(.03).release(.2).delay(.25).room(.3).gain(.6)
sawlead: n("0 2 4 [7 4] 2 ~ 0 ~").scale("C4:minor").s("supersaw").unison(3).detune(.2).lpf(3000).lpq(4).attack(.01).release(.15).delay(.25).gain(.7).orbit(2)
whistle: n("0 2 4 [7 4] 2 ~ 0 ~").scale("C6:major").s("sine").noise(.12).penv(1).pattack(.08).vib("5.5:.25").attack(.06).release(.15).room(.3).gain(.42).orbit(3)
```

`vib("rate:depth")` is Hz and semitones. `penv(1).pattack(.08)` scoops up
from a semitone **below** (a negative `penv` with `pattack` starts above).

## Ambiences and textures

Written long: one event lasts several cycles (`.slow(n)`), and `attack` and
`release` crossfade one into the next. Render them as a `loop` with a
`tail`.

```strudel
wind: s("pink").slow(4).bpf(700).bpq(1.2).bprate(.13).bpdepth(1.6).tremolo(".23:.6").tremoloshape("sine").attack(1.5).release(2).gain(3.5).jux(x=>x.late(.013))
ocean: s("pink").slow(8).lpf(900).lprate(.125).lpdepth(1.6).tremolo(".125:.85").tremoloshape("sine").attack(2).release(2).gain(2.5).jux(x=>x.late(.013))
rain: stack(s("white").hpf(2500).lpf(9000).gain(.12).layer(x=>x.pan(0), x=>x.late(.011).pan(1)), s("crackle").density(.4).lpf(7000).hpf(800).gain(.9)).slow(4).attack(1).release(1.5)
```

```strudel
vinyl: stack(s("crackle").density(.04).lpf(6000).gain(1.2), s("pink").hpf(2000).gain(.04)).slow(4).attack(.5).release(.5)
roomtone: stack(freq(50).s("user").partials([1,.4,.2]).gain(.06), s("brown").lpf(500).gain(1.5)).slow(4).attack(1).release(1)
shimmer: n(irand(10).segment(16)).scale("C6:major:pentatonic").s("sine").decay(.12).sustain(0).release(.1).degradeBy(.4).pan(rand).delay(.5).delaytime(.19).room(.7).rsize(6).gain(.35)
```

- `wind`: `bprate`/`bpdepth` wander the band, the sine `tremolo` makes the
  gusts; `bpq` 4–8 howls. `ocean`: change `lprate` and the tremolo rate
  together — that is the wave's period.
- `.jux(x=>x.late(.013))` is what makes noise stereo, and as wide as
  stereo gets (correlation about 0): right for an ambience on its own, too
  wide for a part of a mix.
- `rain`: `density` is the drops (about 450 × density a second).
- `roomtone`: `freq(60)` where the mains are 60 Hz.
- The gains of `pink` and `brown` are high on purpose: they are quiet
  sources.

## Designed sounds: transitions, hits, interface

One-shots. Render each alone (`only`, a `tail` as long as its ring) into
`assets/audio/` or `assets/sounds/`. Times in seconds do not change with
the tempo; an event's length does. A block that sets no tempo is written
for the default, where a cycle is 2 s.

```strudel
riser: s("white").slow(2).lpf(200).lpenv(6).lpattack(4).lpq(6).attack(4).release(.05).gain(.8)
```

```strudel
pitchriser: note("c3").slow(2).s("supersaw").penv(24).pattack(4).panchor(0).lpf(4000).attack(3).release(.05).gain(.6)
```

```strudel
downlifter: s("white").slow(2).lpf(150).lpenv(-6).lpattack(3).lpq(6).decay(3.5).sustain(0).gain(.8)
```

```strudel
whoosh: s("pink").struct("x ~").bpf(300).bpenv(4).bpattack(.45).bpdecay(.5).bpsustain(0).attack(.45).decay(.5).sustain(0).pan(0).env({ a: 1, depthabs: 2 }).gain(5)
```

```strudel
setcps(.25)
impact: stack(s("sbd").note("c1").decay(2).pdecay(.5).penv(30).gain(.5), s("white").lpf(1200).lpenv(-3).lpattack(.4).decay(.8).sustain(0).gain(.5)).room(.7).rsize(6).struct("x ~ ~ ~")
```

```strudel
setcps(.25)
braam: note("[c1,c2,g2,c3]").struct("x ~").s("sawtooth").lpf(500).lpenv(3).lpattack(.1).lpdecay(1.8).lpsustain(.3).lprelease(1.5).attack(.04).release(1.5).distort("2:.3").room(.6).rsize(7).gain(.45)
```

```strudel
setcps(.25)
subdrop: note("c1").s("sine").penv(24).pdecay(1.5).decay(2).sustain(0).gain(1).struct("x ~")
```

- **riser / downlifter**: the length is `.slow`, `lpattack` and `attack`
  (or `decay`) changed together. A rising sweep is `lpenv(+n).lpattack`, a
  falling one `lpenv(-n).lpattack`. A riser is loudest at the end of its
  event: in a piece, make it the last event before the hit
  (`strudel-forms`); as a file, render it with `tail: 0` and start the
  impact on its last frame.
- **pitchriser**: `panchor(0)` makes the pitch start on the note and rise;
  keep `release` short, the pitch snaps back at note-off.
- **whoosh**: 1 s, left to right; `pan(1)` with `depthabs: -2` for right to
  left. Keep `attack + decay` a little under the event's length.
- **impact / subdrop**: nearly all their energy is under 60 Hz. For a phone,
  raise the `sbd` note to `c2`. The impact rings 5 s: `tail: 5`.
- **braam**: `lpenv(4)` brassier, `lpf(300)` darker. `distort("amount:level")`
  — always give the level: distortion is a gain of 12 dB at 2.

```strudel
blip: note("c6 ~ ~ c6 ~ ~ g6 ~").s("sine").decay(.08).sustain(0).gain(.6)
ping: note("~ ~ [e6 a6] ~").s("sine").fm(.6).fmh(3).fmdecay(.1).decay(.35).sustain(0).release(.3).clip(.5).delay(.3).delaytime(.18).delayfeedback(.3).gain(.5)
tick: s("white*2").bpf("<4200 3300>*2").bpq(8).decay(.012).gain(6).orbit(2)
```

```strudel
setcps(1)
heartbeat: s("sbd ~ sbd ~ ~ ~ ~ ~").note("a1").decay(.2).pdecay(.1).penv(12).lpf(200).gain("[.5 ~ .35 ~ ~ ~ ~ ~]")
glitch: s("bytebeat*16").n(irand(15)).note(irand(24).add(36)).crush(4).coarse("<4 12>").degradeBy(.35).decay(.06).sustain(0).pan(rand).gain(.5)
```

- `blip`: pitch is meaning (a rising pair confirms, a falling one
  declines); `decay` .03 a click, .15 soft. `tick`: one a second at the
  default tempo, two pitches for tick and tock.
- `heartbeat`: the tempo is the heart rate (`setcps(1)` = 60 a minute).
- `glitch`: `crush` 3–8 only — 1 and 2 render silence. Use it in bursts:
  `.mask("<1 0 0 0>")`.
- The `z_*` sounds (`z_sine`, `z_square`…) are game one-shots with their
  own controls: `slide(2)` rises, `pitchJump(400).pitchJumpTime(.08)` is a
  coin. They ignore `penv`, `fm` and `vib`.

## What this engine does not do

Say it in the brief rather than fake it:

- a real piano, strings, brass, woodwinds, guitar, a voice;
- cymbals and snares that pass for recorded ones when exposed;
- chorus, flanger, a glide between notes, reversed or stretched sound.

For those, a recording: a licensed one (`find-archive-media`), or an audio
file of the workspace loaded as a sample (`strudel-music`).
