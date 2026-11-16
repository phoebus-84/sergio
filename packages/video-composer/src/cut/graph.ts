// ---------------------------------------------------------------------------
// One window of a cut as an FFmpeg run
// ---------------------------------------------------------------------------
// Pure: a window of the timeline in, the arguments of the FFmpeg run that
// renders it out. Nothing here touches a file, so the same input always gives
// the same arguments — which is what lets a render be kept and used again.
//
// Picture: a black frame of the cut's size, then each clip that plays in the
// window laid over it in track order. A clip is brought to the cut's rate and
// size, treated by its effects, and timed twice: first so that its own first
// frame is zero (a fade is where the clip says, even when the window starts
// inside it), then to its place in the window.
//
// Sound: each clip of one bus conformed to 48 kHz stereo, retimed, levelled,
// treated, faded and delayed into place, then summed. Gains are never
// normalised: a level is what it says.
// ---------------------------------------------------------------------------

import { effectFilters, effectFiles, effectsNeedAlpha, effectDefinition, tempoFilters, n, type EffectContext, type EffectSpec } from "./effects.js";
import { SAMPLE_RATE, clipEnd, clipsIn, type Bus, type Window } from "./plan.js";
import type { Cut, CutClip, CutTransition, MediaInfo } from "./types.js";

export interface Job {
  /** FFmpeg's arguments, up to but not including the output file. */
  args: string[];
  /** The files the run reads: what the result depends on. */
  files: string[];
}

export interface GraphOptions {
  /** The size the picture is rendered at: the cut's, or smaller for a preview. */
  width: number;
  height: number;
  resolveFile: (file: string) => string;
}

/** A chain's head and its filters: an input label is followed directly, a filter by a comma. */
const chain = (head: string, steps: readonly string[]): string =>
  head.endsWith("]") ? `${head}${steps.join(",")}` : [head, ...steps].join(",");

const isWipe = (transition: CutTransition | undefined): boolean => !!transition && transition.type.startsWith("wipe-");

/** Seconds of margin read past what a clip needs: FFmpeg's seek lands on a frame, not on an instant. */
const READ_MARGIN = 1;

/** Effects that keep a picture's transparency go last: a filter after them may not carry an alpha channel. */
function orderedEffects(effects: readonly EffectSpec[] | undefined): EffectSpec[] {
  const list = (effects ?? []).filter((effect) => effect.enabled !== false);
  const makesAlpha = (effect: EffectSpec) => effectDefinition("video", effect.type)?.alpha === true;
  return [...list.filter((effect) => !makesAlpha(effect)), ...list.filter(makesAlpha)];
}

/**
 * The mask of a wipe: a white frame sliding over a black one. Where it is
 * white the clip shows. `t` is the window's time; the clip's own time is
 * `t + local`.
 */
function wipeMask(clip: CutClip, fps: number, width: number, height: number, seconds: number, local: number, label: string): string {
  const total = clip.duration / fps;
  let x = "0";
  let y = "0";
  const own = `(t+${n(local)})`;
  const into = clip.transitionIn;
  if (into && isWipe(into)) {
    const p = `clip(${own}/${n(into.duration / fps)}\\,0\\,1)`;
    if (into.type === "wipe-left") x = `${width}*(1-${p})`;
    if (into.type === "wipe-right") x = `-${width}*(1-${p})`;
    if (into.type === "wipe-up") y = `${height}*(1-${p})`;
    if (into.type === "wipe-down") y = `-${height}*(1-${p})`;
  }
  const out = clip.transitionOut;
  if (out && isWipe(out)) {
    const q = `clip((${own}-${n(total - out.duration / fps)})/${n(out.duration / fps)}\\,0\\,1)`;
    if (out.type === "wipe-left") x = `${x}-${width}*${q}`;
    if (out.type === "wipe-right") x = `${x}+${width}*${q}`;
    if (out.type === "wipe-up") y = `${y}-${height}*${q}`;
    if (out.type === "wipe-down") y = `${y}+${height}*${q}`;
  }
  const source = (color: string) => `color=c=${color}:s=${width}x${height}:r=${fps}:d=${n(seconds)}`;
  return `${source("black")}[${label}k];${source("white")}[${label}w];[${label}k][${label}w]overlay=x='${x}':y='${y}',format=gray[${label}m]`;
}

/** The picture of one window. `job.args` ends with the mapped, unencoded picture labelled for output. */
export function pictureJob(cut: Cut, window: Window, media: ReadonlyMap<string, MediaInfo>, options: GraphOptions): Job {
  const [from, to] = window;
  const fps = cut.fps;
  const { width, height } = options;
  const seconds = (to - from) / fps;
  const inputs: string[] = [];
  const files: string[] = [];
  const chains: string[] = [`color=c=black:s=${width}x${height}:r=${fps}:d=${n(seconds)},format=yuv420p[b0]`];
  let last = "b0";
  let stage = 0;
  let input = 0;

  for (const track of cut.tracks) {
    if (track.kind !== "video" || track.muted) continue;
    for (const clip of clipsIn(track, window)) {
      const start = Math.max(clip.at, from);
      const end = Math.min(clipEnd(clip), to);
      const held = (end - start) / fps;
      /** Seconds of the clip before this window. */
      const local = (start - clip.at) / fps;
      /** Seconds of the window before the clip. */
      const place = (start - from) / fps;
      const speed = clip.speed ?? 1;
      const label = `c${stage}`;
      const steps: string[] = [];
      let head: string;
      let sourceAlpha = false;

      if ("color" in clip.media) {
        head = `color=c=0x${clip.media.color.slice(1)}:s=${width}x${height}:r=${fps}:d=${n(held)}`;
      } else {
        const info = media.get(clip.media.file);
        if (!info) throw new Error(`${clip.media.file} was not probed`);
        files.push(clip.media.file);
        sourceAlpha = info.hasAlpha;
        if (info.kind === "image") {
          inputs.push("-loop", "1", "-framerate", String(fps), "-t", n(held + READ_MARGIN), "-i", clip.media.file);
          steps.push("setpts=PTS-STARTPTS");
        } else {
          const at = (clip.in ?? 0) + local * speed;
          inputs.push("-ss", n(at), "-t", n(held * speed + READ_MARGIN), "-i", clip.media.file);
          steps.push(speed === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${n(speed)}`, `fps=${fps}`);
        }
        head = `[${input}:v]`;
        input += 1;
        const fit = clip.fit ?? "cover";
        if (fit === "cover") steps.push(`scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${width}:${height}`);
        else if (fit === "contain") steps.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`);
        else steps.push(`scale=${width}:${height}:flags=lanczos`);
        steps.push("setsar=1");
      }

      const context: EffectContext = {
        width, height, fps, clipFrames: clip.duration, frameOffset: start - clip.at, resolveFile: options.resolveFile,
      };
      const effects = orderedEffects(clip.effects);
      files.push(...effectFiles("video", effects, options.resolveFile));
      const plain = effects.filter((effect) => effectDefinition("video", effect.type)?.alpha !== true);
      const matte = effects.filter((effect) => effectDefinition("video", effect.type)?.alpha === true);
      const dissolves = [clip.transitionIn, clip.transitionOut].some((t) => t?.type === "dissolve");
      const wipes = isWipe(clip.transitionIn) || isWipe(clip.transitionOut);
      // A clip fitted inside the frame is given a transparent surround: every clip is then the frame's size.
      const contained = (clip.fit ?? "cover") === "contain" && !("color" in clip.media);
      const alpha = sourceAlpha || contained || matte.length > 0 || dissolves || wipes || (clip.opacity ?? 1) < 1 || effectsNeedAlpha(clip.effects);

      const prefix: string[] = [];
      if (sourceAlpha && plain.length > 0) {
        // The colour is treated on its own and given its transparency back: most filters would drop it.
        prefix.push(`${chain(head, [...steps, "format=yuva420p", "split"])}[${label}p][${label}q]`);
        prefix.push(`[${label}q]alphaextract[${label}a]`);
        prefix.push(`[${label}p]${["format=yuv420p", ...effectFilters("video", plain, context)].join(",")}[${label}e]`);
        prefix.push(`[${label}e][${label}a]alphamerge[${label}s]`);
        head = `[${label}s]`;
        steps.length = 0;
      } else {
        if (!sourceAlpha) steps.push("format=yuv420p");
        steps.push(...effectFilters("video", plain, context));
      }
      if (alpha) steps.push("format=yuva420p");
      if (contained) steps.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
      steps.push(...effectFilters("video", matte, context));
      steps.push(`trim=duration=${n(held)}`, "setpts=PTS-STARTPTS");

      if (wipes) {
        prefix.push(wipeMask(clip, fps, width, height, held, local, label));
        if (sourceAlpha || contained || matte.length > 0) {
          // The clip is already transparent in places: the wipe hides more of it, and reveals none of that.
          prefix.push(`${chain(head, [...steps, "split"])}[${label}v][${label}u]`);
          prefix.push(`[${label}u]alphaextract[${label}x]`);
          prefix.push(`[${label}x][${label}m]blend=all_mode=multiply[${label}y]`);
          head = `[${label}v][${label}y]alphamerge`;
        } else {
          prefix.push(`${chain(head, steps)}[${label}v]`);
          head = `[${label}v][${label}m]alphamerge`;
        }
        steps.length = 0;
      }

      // The clip's own clock, for what happens at its edges; then its place in the window.
      steps.push(`setpts=PTS+${n(local)}/TB`);
      const total = clip.duration / fps;
      const into = clip.transitionIn;
      if (into && !isWipe(into) && local < into.duration / fps) {
        steps.push(`fade=t=in:st=0:d=${n(into.duration / fps)}${into.type === "dissolve" ? ":alpha=1" : ""}`);
      }
      const out = clip.transitionOut;
      if (out && !isWipe(out) && local + held > total - out.duration / fps) {
        steps.push(`fade=t=out:st=${n(total - out.duration / fps)}:d=${n(out.duration / fps)}${out.type === "dissolve" ? ":alpha=1" : ""}`);
      }
      if ((clip.opacity ?? 1) < 1) steps.push(`colorchannelmixer=aa=${n(clip.opacity!)}`);
      steps.push(`setpts=PTS+${n(place - local)}/TB`);

      chains.push(...prefix, `${chain(head, steps)}[${label}]`);
      // A quarter frame of slack on each side: frame times are sums of fractions.
      const slack = 0.25 / fps;
      const next = `b${stage + 1}`;
      chains.push(`[${last}][${label}]overlay=x=0:y=0:eof_action=repeat:enable='gte(t\\,${n(place - slack)})*lt(t\\,${n(place + held - slack)})'[${next}]`);
      last = next;
      stage += 1;
    }
  }

  const master = effectFilters("video", cut.master?.video, {
    width, height, fps, clipFrames: Math.max(1, to), frameOffset: from, resolveFile: options.resolveFile,
  });
  chains.push(`[${last}]${[...master, "format=yuv420p", "setsar=1"].join(",")}[vout]`);
  files.push(...effectFiles("video", cut.master?.video, options.resolveFile));

  return {
    args: [...inputs, "-filter_complex", chains.join(";"), "-map", "[vout]", "-an", "-r", String(fps), "-frames:v", String(to - from)],
    files,
  };
}

/** A dB curve as an expression of t: down by `gain` while any span plays, ramped in and out. */
export function duckExpression(spans: readonly (readonly [number, number])[], gain: number, attack: number, release: number): string {
  const merged: [number, number][] = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const previous = merged[merged.length - 1];
    // Spans closer than their ramps are one: the bed does not bob between two phrases.
    if (previous && start - previous[1] <= attack + release) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  if (merged.length === 0) return "0";
  const one = ([start, end]: [number, number]) => {
    const up = attack > 0 ? `clip((t-${n(start - attack)})/${n(attack)}\\,0\\,1)` : `gte(t\\,${n(start)})`;
    const down = release > 0 ? `clip((${n(end + release)}-t)/${n(release)}\\,0\\,1)` : `lte(t\\,${n(end)})`;
    return `min(${up}\\,${down})`;
  };
  return `${n(gain)}*${merged.map(one).reduce((all, x) => `max(${all}\\,${x})`)}`;
}

const STEREO = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`;

/** The sound of one bus in one window, as 48 kHz stereo of exactly the window's length. */
export function soundJob(cut: Cut, bus: Bus, window: Window, all: readonly Bus[]): Job {
  const [from, to] = window;
  const fps = cut.fps;
  const samples = ((to - from) * SAMPLE_RATE) / fps;
  const inputs: string[] = [];
  const files: string[] = [];
  const chains: string[] = [`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end_sample=${samples},${STEREO}[sil]`];
  const labels: string[] = ["sil"];
  const picture = bus.track.kind === "video";

  bus.clips.filter((clip) => clip.at < to && clipEnd(clip) > from).forEach((clip, k) => {
    if (!("file" in clip.media)) return;
    const file = clip.media.audioFile ?? clip.media.file;
    const start = Math.max(clip.at, from);
    const end = Math.min(clipEnd(clip), to);
    const held = (end - start) / fps;
    const local = (start - clip.at) / fps;
    const speed = clip.speed ?? 1;
    files.push(file);
    inputs.push("-ss", n((clip.in ?? 0) + local * speed), "-t", n(held * speed + READ_MARGIN), "-i", file);

    const gain = (picture ? clip.audio?.gain : clip.gain) ?? 0;
    const effects = picture ? clip.audio?.effects : clip.effects;
    const fadeIn = ((picture ? clip.audio?.fadeIn : clip.fadeIn) ?? 0) / fps;
    const fadeOut = ((picture ? clip.audio?.fadeOut : clip.fadeOut) ?? 0) / fps;
    const total = clip.duration / fps;
    const steps = [`aresample=${SAMPLE_RATE}`, STEREO, ...tempoFilters(speed), `atrim=duration=${n(held)}`, "asetpts=PTS-STARTPTS"];
    if (gain !== 0) steps.push(`volume=${n(gain)}dB`);
    const treated = effectFilters("audio", effects, { width: cut.width, height: cut.height, fps, clipFrames: clip.duration, frameOffset: start - clip.at, resolveFile: (f) => f });
    if (treated.length > 0) steps.push(...treated, `aresample=${SAMPLE_RATE}`, STEREO);
    const fades: string[] = [];
    if (fadeIn > 0 && local < fadeIn) fades.push(`afade=t=in:st=0:d=${n(fadeIn)}:curve=qsin`);
    if (fadeOut > 0 && local + held > total - fadeOut) fades.push(`afade=t=out:st=${n(total - fadeOut)}:d=${n(fadeOut)}:curve=qsin`);
    if (fades.length > 0) steps.push(`asetpts=PTS+${n(local)}/TB`, ...fades, "asetpts=PTS-STARTPTS");
    const offset = ((start - from) * SAMPLE_RATE) / fps;
    if (offset > 0) steps.push(`adelay=delays=${offset}S:all=1`);
    chains.push(`[${k}:a]${steps.join(",")}[a${k}]`);
    labels.push(`a${k}`);
  });

  const steps = [labels.length > 1 ? `amix=inputs=${labels.length}:normalize=0:dropout_transition=0` : "anull"];
  const duck = bus.track.duck;
  if (duck) {
    const spans: [number, number][] = [];
    for (const other of all) {
      if (!duck.under.includes(other.id)) continue;
      for (const clip of other.clips) {
        if (clip.at < to && clipEnd(clip) > from) spans.push([(clip.at - from) / fps, (clipEnd(clip) - from) / fps]);
      }
    }
    if (spans.length > 0) {
      // Evaluated every 64 samples: once per decoded frame would move the level in audible steps.
      steps.push("asetnsamples=n=64:p=0", `volume='pow(10\\,(${duckExpression(spans, duck.gain, duck.attack ?? 0.25, duck.release ?? 0.6)})/20)':eval=frame`);
    }
  }
  steps.push(`atrim=end_sample=${samples}`, "asetpts=PTS-STARTPTS");
  chains.push(`${labels.map((label) => `[${label}]`).join("")}${steps.join(",")}[aout]`);

  return {
    args: [...inputs, "-filter_complex", chains.join(";"), "-map", "[aout]", "-vn", "-c:a", "pcm_f32le", "-ar", String(SAMPLE_RATE), "-ac", "2"],
    files,
  };
}

/** The buses' stems summed into the mix: each treated by its track's effects and set to its level, then the master's effects. */
export function mixJob(cut: Cut, stems: readonly { bus: Bus; file: string }[]): Job {
  const context: EffectContext = { width: cut.width, height: cut.height, fps: cut.fps, clipFrames: 1, frameOffset: 0, resolveFile: (f) => f };
  const chains: string[] = [];
  const labels: string[] = [];
  stems.forEach(({ bus }, k) => {
    const steps = [...effectFilters("audio", bus.track.effects, context)];
    // A picture track's level is its clips': only a sound track has a fader.
    if (bus.track.kind === "audio" && bus.track.gain) steps.push(`volume=${n(bus.track.gain)}dB`);
    steps.push(`aresample=${SAMPLE_RATE}`, STEREO);
    chains.push(`[${k}:a]${steps.join(",")}[s${k}]`);
    labels.push(`s${k}`);
  });
  const master = effectFilters("audio", cut.master?.audio, context);
  const sum = labels.length > 1 ? `amix=inputs=${labels.length}:normalize=0:dropout_transition=0` : "anull";
  chains.push(`${labels.map((label) => `[${label}]`).join("")}${[sum, ...master, `aresample=${SAMPLE_RATE}`, STEREO].join(",")}[mix]`);
  return {
    args: [...stems.flatMap(({ file }) => ["-i", file]), "-filter_complex", chains.join(";"), "-map", "[mix]", "-vn", "-c:a", "pcm_f32le", "-ar", String(SAMPLE_RATE), "-ac", "2"],
    files: stems.map(({ file }) => file),
  };
}

/** How a picture chunk is encoded. Every chunk of a render is encoded alike, so they join without re-encoding. */
export function pictureEncoding(quality: "preview" | "final", fps: number): string[] {
  const common = ["-pix_fmt", "yuv420p", "-g", String(fps * 2), "-keyint_min", String(fps), "-sc_threshold", "0", "-bf", "0", "-video_track_timescale", "90000"];
  return quality === "preview"
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "27", ...common]
    : ["-c:v", "libx264", "-preset", "medium", "-crf", "16", ...common];
}
