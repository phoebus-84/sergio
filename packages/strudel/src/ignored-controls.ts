// ---------------------------------------------------------------------------
// Controls that exist in Strudel and change nothing here.
//
// @strudel/core registers every control of every output it can drive:
// SuperDirt's effects, MIDI, OSC. A piece that uses one evaluates without an
// error, and the built-in engine (superdough) simply never reads it — which
// nobody who cannot hear would notice. These are the ones of Strudel 1.3.0:
// each is named nowhere in superdough's sources, and a render with it was
// the same, sample for sample, as the render without it, on a synth and on a
// sample. Controls the engine reads only in some cases (`cut`, `amp`…) are
// left out: a warning that is wrong is worse than none.
//
// Revise when the pinned Strudel changes.
// ---------------------------------------------------------------------------

export const IGNORED_CONTROLS: ReadonlySet<string> = new Set([
  // effects of SuperDirt that superdough does not have
  "accelerate", "binshift", "chorus", "comb", "delayspeed", "enhance", "fshift", "fshiftnote", "fshiftphase", "hbrick", "kcutoff", "krush",
  "lbrick", "leslie", "lrate", "lsize", "octer", "octersub", "octersubsub", "overgain", "overshape", "ring", "ringdf", "ringf", "scram",
  "smear", "squiz", "triode", "tsdelay", "waveloss", "xsdelay", "hold", "fadeTime", "expression", "sustainpedal",
  // panning of multichannel set-ups
  "panorient", "panspan", "pansplay", "panwidth",
  // pitch and harmony that nothing turned into notes
  "chord", "dictionary", "degree", "harmonic", "ctranspose", "mtranspose", "octaveR", "octaves", "semitone", "stepsPerOctave",
  // MIDI and OSC
  "ccn", "ccv", "ctlNum", "midibend", "midichan", "midicmd", "midimap", "midiport", "miditouch", "nrpnn", "nrpv", "polyTouch", "progNum",
  "sysexdata", "sysexid", "oschost", "oscport",
  // other outputs
  "frameRate", "hours", "minutes", "songPtr",
  // what room("level:size") writes: the engine reads the size as roomsize (.rsize), never as this
  "size",
]);

/** What to say about a control of the list, by what it was probably meant to do. */
export function ignoredControlHint(name: string): string {
  if (name === "size") return 'room("level:size") does not set the reverb\'s size here: write .room(level).rsize(seconds)';
  if (name === "chord") return "chord() names a chord but plays none: add .voicing() (or write the notes)";
  if (["dictionary", "degree", "octaves", "stepsPerOctave", "ctranspose", "mtranspose", "semitone", "octaveR", "harmonic"].includes(name)) {
    return `"${name}" is read by no function this piece calls and by no sound: it changes nothing`;
  }
  if (/^(cc|midi|nrpn|sysex|osc|ctlNum|progNum|polyTouch)/.test(name)) return `"${name}" is for MIDI or OSC: the built-in engine does not read it`;
  return `"${name}" is an effect of other Strudel outputs: the built-in engine does not read it, so it changes nothing`;
}
