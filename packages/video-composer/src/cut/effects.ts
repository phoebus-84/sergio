// ---------------------------------------------------------------------------
// The effect catalog: what a cut can do to picture and to sound
// ---------------------------------------------------------------------------
// An effect is a name and a few plain parameters. The catalog says what each
// parameter is — its range, its default, what it means — so a form can be
// drawn from it and a value checked against it, and it holds the one place
// that turns the effect into FFmpeg filters. A cut never carries a filter
// string: an arbitrary one is a shell fragment by another name.
// ---------------------------------------------------------------------------

export type EffectDomain = "video" | "audio";

export type EffectParam =
  | { kind: "number"; min: number; max: number; default: number; step?: number; unit?: string; description: string }
  | { kind: "enum"; values: readonly string[]; default: string; description: string }
  | { kind: "boolean"; default: boolean; description: string }
  | { kind: "color"; default: string; description: string }
  | { kind: "file"; extensions: readonly string[]; description: string };

export interface EffectSpec {
  type: string;
  params?: Record<string, number | string | boolean>;
  enabled?: boolean;
}

/** What a filter builder knows about where the effect is applied. */
export interface EffectContext {
  width: number;
  height: number;
  fps: number;
  /** Frames the treated clip holds on the timeline; the whole cut for a master effect. */
  clipFrames: number;
  /** Frames of the clip before this render window: a window may start inside a clip. */
  frameOffset: number;
  /** A file an effect names (a LUT), as the path FFmpeg opens. */
  resolveFile: (file: string) => string;
}

export interface EffectDefinition {
  type: string;
  domain: EffectDomain;
  title: string;
  description: string;
  group: string;
  params: Record<string, EffectParam>;
  /** The picture gains transparency: the clip is composited with an alpha channel. */
  alpha?: boolean;
  /** The FFmpeg filters, in order. Values are already validated and defaulted. */
  filters: (params: Record<string, number | string | boolean>, context: EffectContext) => string[];
}

export interface EffectProblem {
  code: "unknown-effect" | "wrong-domain" | "unknown-param" | "bad-param" | "missing-param";
  path: string;
  message: string;
}

const num = (min: number, max: number, def: number, description: string, extra: { step?: number; unit?: string } = {}): EffectParam =>
  ({ kind: "number", min, max, default: def, description, ...extra });

/** A number as a filter argument: six decimals, no exponent. */
export const n = (value: number): string => (Math.round(value * 1e6) / 1e6).toString();

/** dB as the linear factor FFmpeg's dynamics filters take. */
const linear = (db: number): string => n(Math.pow(10, db / 20));

/** A value inside a filter argument: the graph's separators escaped. */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

const hex = (color: string): string => `0x${color.replace(/^#/, "")}`;

const CURVE_PRESETS = [
  "color_negative", "cross_process", "darker", "increase_contrast", "lighter", "linear_contrast",
  "medium_contrast", "negative", "strong_contrast", "vintage",
] as const;

const REVERBS: Record<string, { delays: string; decays: string }> = {
  room: { delays: "23|41", decays: "0.30|0.18" },
  chamber: { delays: "37|61|89", decays: "0.34|0.24|0.14" },
  hall: { delays: "61|113|197|283", decays: "0.38|0.30|0.22|0.14" },
  cathedral: { delays: "113|241|401|613|811", decays: "0.42|0.36|0.30|0.22|0.16" },
};

const VIDEO: EffectDefinition[] = [
  {
    type: "exposure", domain: "video", group: "Light", title: "Exposure",
    description: "Brighter or darker, in stops",
    params: { stops: num(-3, 3, 0, "Stops of exposure", { step: 0.05, unit: "EV" }) },
    filters: (p) => [`exposure=exposure=${n(p.stops as number)}`],
  },
  {
    type: "brightness", domain: "video", group: "Light", title: "Brightness",
    description: "Lifts or lowers every value alike",
    params: { amount: num(-1, 1, 0, "Offset", { step: 0.01 }) },
    filters: (p) => [`eq=brightness=${n(p.amount as number)}`],
  },
  {
    type: "contrast", domain: "video", group: "Light", title: "Contrast",
    description: "The distance between dark and light",
    params: { amount: num(0, 3, 1, "1 leaves it as it is", { step: 0.01 }) },
    filters: (p) => [`eq=contrast=${n(p.amount as number)}`],
  },
  {
    type: "gamma", domain: "video", group: "Light", title: "Gamma",
    description: "Midtones, leaving black and white where they are",
    params: { amount: num(0.1, 4, 1, "1 leaves it as it is", { step: 0.01 }) },
    filters: (p) => [`eq=gamma=${n(p.amount as number)}`],
  },
  {
    type: "curves", domain: "video", group: "Light", title: "Curves",
    description: "A tone curve by name",
    params: { preset: { kind: "enum", values: CURVE_PRESETS, default: "medium_contrast", description: "The curve" } },
    filters: (p) => [`curves=preset=${p.preset as string}`],
  },
  {
    type: "saturation", domain: "video", group: "Colour", title: "Saturation",
    description: "How much colour",
    params: { amount: num(0, 3, 1, "0 is black and white, 1 leaves it as it is", { step: 0.01 }) },
    filters: (p) => [`eq=saturation=${n(p.amount as number)}`],
  },
  {
    type: "vibrance", domain: "video", group: "Colour", title: "Vibrance",
    description: "Saturation for the muted colours first, sparing skin",
    params: { amount: num(-2, 2, 0.3, "Intensity", { step: 0.01 }) },
    filters: (p) => [`vibrance=intensity=${n(p.amount as number)}`],
  },
  {
    type: "temperature", domain: "video", group: "Colour", title: "Temperature",
    description: "Warmer or cooler white",
    params: {
      kelvin: num(2000, 12000, 6500, "The light's temperature", { step: 50, unit: "K" }),
      mix: num(0, 1, 1, "How much of the change is kept", { step: 0.01 }),
    },
    filters: (p) => [`colortemperature=temperature=${n(p.kelvin as number)}:mix=${n(p.mix as number)}`],
  },
  {
    type: "tint", domain: "video", group: "Colour", title: "Colour balance",
    description: "Push shadows, midtones and highlights towards a colour",
    params: {
      shadowsRed: num(-1, 1, 0, "Shadows: cyan to red", { step: 0.01 }),
      shadowsGreen: num(-1, 1, 0, "Shadows: magenta to green", { step: 0.01 }),
      shadowsBlue: num(-1, 1, 0, "Shadows: yellow to blue", { step: 0.01 }),
      midtonesRed: num(-1, 1, 0, "Midtones: cyan to red", { step: 0.01 }),
      midtonesGreen: num(-1, 1, 0, "Midtones: magenta to green", { step: 0.01 }),
      midtonesBlue: num(-1, 1, 0, "Midtones: yellow to blue", { step: 0.01 }),
      highlightsRed: num(-1, 1, 0, "Highlights: cyan to red", { step: 0.01 }),
      highlightsGreen: num(-1, 1, 0, "Highlights: magenta to green", { step: 0.01 }),
      highlightsBlue: num(-1, 1, 0, "Highlights: yellow to blue", { step: 0.01 }),
    },
    filters: (p) => [
      `colorbalance=rs=${n(p.shadowsRed as number)}:gs=${n(p.shadowsGreen as number)}:bs=${n(p.shadowsBlue as number)}` +
      `:rm=${n(p.midtonesRed as number)}:gm=${n(p.midtonesGreen as number)}:bm=${n(p.midtonesBlue as number)}` +
      `:rh=${n(p.highlightsRed as number)}:gh=${n(p.highlightsGreen as number)}:bh=${n(p.highlightsBlue as number)}`,
    ],
  },
  {
    type: "hue", domain: "video", group: "Colour", title: "Hue",
    description: "Turn every colour around the wheel",
    params: { degrees: num(-180, 180, 0, "The turn", { step: 1, unit: "°" }) },
    filters: (p) => [`hue=h=${n(p.degrees as number)}`],
  },
  {
    type: "lut", domain: "video", group: "Colour", title: "LUT",
    description: "A look as a 3D lookup table (.cube)",
    params: {
      file: { kind: "file", extensions: [".cube", ".3dl"], description: "The LUT file" },
      interpolation: { kind: "enum", values: ["trilinear", "tetrahedral", "nearest"], default: "tetrahedral", description: "How values between the table's points are read" },
    },
    filters: (p, c) => [`lut3d=file='${escapeFilterValue(c.resolveFile(p.file as string))}':interp=${p.interpolation as string}`],
  },
  {
    type: "monochrome", domain: "video", group: "Colour", title: "Black and white",
    description: "No colour",
    params: {},
    filters: () => ["hue=s=0"],
  },
  {
    type: "sepia", domain: "video", group: "Colour", title: "Sepia",
    description: "The brown of an old print",
    params: {},
    filters: () => ["colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131"],
  },
  {
    type: "vignette", domain: "video", group: "Lens", title: "Vignette",
    description: "Darker towards the corners",
    params: { amount: num(0, 1, 0.4, "How far in the dark reaches", { step: 0.01 }) },
    filters: (p) => [`vignette=angle=${n((p.amount as number) * 1.3)}`],
  },
  {
    type: "blur", domain: "video", group: "Lens", title: "Blur",
    description: "Out of focus",
    params: { radius: num(0, 80, 6, "The blur's radius", { step: 0.5, unit: "px" }) },
    filters: (p) => [`gblur=sigma=${n(p.radius as number)}`],
  },
  {
    type: "sharpen", domain: "video", group: "Lens", title: "Sharpen",
    description: "Crisper edges",
    params: { amount: num(0, 3, 0.8, "Strength", { step: 0.05 }) },
    filters: (p) => [`unsharp=5:5:${n(p.amount as number)}:5:5:0`],
  },
  {
    type: "grain", domain: "video", group: "Texture", title: "Grain",
    description: "Film grain that changes every frame",
    params: { amount: num(0, 60, 10, "Strength", { step: 1 }) },
    filters: (p) => [`noise=alls=${n(p.amount as number)}:allf=t+u`],
  },
  {
    type: "denoise", domain: "video", group: "Texture", title: "Denoise",
    description: "Less sensor noise, in space and in time",
    params: { strength: num(0, 12, 3, "Strength", { step: 0.5 }) },
    filters: (p) => [`hqdn3d=${n(p.strength as number)}:${n((p.strength as number) * 0.75)}:${n((p.strength as number) * 1.5)}:${n((p.strength as number) * 1.1)}`],
  },
  {
    type: "deinterlace", domain: "video", group: "Repair", title: "Deinterlace",
    description: "Interlaced footage made progressive",
    params: {},
    filters: () => ["bwdif=mode=send_frame"],
  },
  {
    type: "stabilize", domain: "video", group: "Repair", title: "Stabilize",
    description: "Steadies a handheld shot, at the cost of its edges",
    params: { range: num(4, 64, 16, "How far a frame may be moved", { step: 1, unit: "px" }) },
    filters: (p) => [`deshake=rx=${n(p.range as number)}:ry=${n(p.range as number)}:edge=mirror`],
  },
  {
    type: "crop", domain: "video", group: "Frame", title: "Crop",
    description: "Keep a part of the frame, enlarged to fill it",
    params: {
      x: num(0, 1, 0, "Left edge, as a fraction of the width", { step: 0.005 }),
      y: num(0, 1, 0, "Top edge, as a fraction of the height", { step: 0.005 }),
      width: num(0.05, 1, 1, "Width kept, as a fraction", { step: 0.005 }),
      height: num(0.05, 1, 1, "Height kept, as a fraction", { step: 0.005 }),
    },
    filters: (p, c) => [
      `crop=w=iw*${n(Math.min(p.width as number, 1 - (p.x as number)))}:h=ih*${n(Math.min(p.height as number, 1 - (p.y as number)))}:x=iw*${n(p.x as number)}:y=ih*${n(p.y as number)}`,
      `scale=${c.width}:${c.height}`,
      "setsar=1",
    ],
  },
  {
    type: "zoom", domain: "video", group: "Frame", title: "Zoom",
    description: "A slow push in or pull out over the clip, towards a point",
    params: {
      from: num(1, 4, 1, "Scale at the clip's first frame", { step: 0.01 }),
      to: num(1, 4, 1.12, "Scale at its last", { step: 0.01 }),
      x: num(0, 1, 0.5, "The point held, across", { step: 0.01 }),
      y: num(0, 1, 0.5, "The point held, down", { step: 0.01 }),
    },
    filters: (p, c) => {
      const span = Math.max(1, c.clipFrames - 1);
      const z = `(${n(p.from as number)}+(${n((p.to as number) - (p.from as number))})*min(1\\,(on+${c.frameOffset})/${span}))`;
      // Rendered at twice the size and scaled down: zoompan moves in whole pixels, and a slow push shows it.
      return [
        `scale=${c.width * 2}:${c.height * 2}`,
        `zoompan=z='${z}':x='(iw-iw/zoom)*${n(p.x as number)}':y='(ih-ih/zoom)*${n(p.y as number)}':d=1:s=${c.width}x${c.height}:fps=${c.fps}`,
        "setsar=1",
      ];
    },
  },
  {
    type: "flip", domain: "video", group: "Frame", title: "Flip",
    description: "Mirrored",
    params: { axis: { kind: "enum", values: ["horizontal", "vertical"], default: "horizontal", description: "Left to right, or top to bottom" } },
    filters: (p) => [p.axis === "vertical" ? "vflip" : "hflip"],
  },
  {
    type: "rotate", domain: "video", group: "Frame", title: "Rotate",
    description: "Turned around its centre, keeping the frame's size",
    params: { degrees: num(-180, 180, 0, "Clockwise", { step: 0.1, unit: "°" }) },
    filters: (p) => [`rotate=${n(((p.degrees as number) * Math.PI) / 180)}:fillcolor=black`],
  },
  {
    type: "letterbox", domain: "video", group: "Frame", title: "Letterbox",
    description: "Black bars to a wider aspect",
    params: { aspect: num(1.34, 4, 2.39, "Width over height of the picture left", { step: 0.01 }) },
    filters: (p, c) => {
      const bar = Math.max(0, Math.round((c.height - c.width / (p.aspect as number)) / 2));
      return bar === 0 ? [] : [`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`];
    },
  },
  {
    type: "chroma-key", domain: "video", group: "Matte", title: "Chroma key", alpha: true,
    description: "A colour made transparent: what is under the clip shows through",
    params: {
      color: { kind: "color", default: "#00ff00", description: "The colour removed" },
      similarity: num(0.01, 1, 0.12, "How far from it still counts", { step: 0.005 }),
      blend: num(0, 1, 0.06, "How soft the edge is", { step: 0.005 }),
    },
    filters: (p) => [`chromakey=color=${hex(p.color as string)}:similarity=${n(p.similarity as number)}:blend=${n(p.blend as number)}`],
  },
];

const AUDIO: EffectDefinition[] = [
  {
    type: "gain", domain: "audio", group: "Level", title: "Gain",
    description: "Louder or quieter",
    params: { db: num(-60, 24, 0, "Change in level", { step: 0.5, unit: "dB" }) },
    filters: (p) => [`volume=${n(p.db as number)}dB`],
  },
  {
    type: "highpass", domain: "audio", group: "Tone", title: "High-pass",
    description: "Removes what is below a frequency: rumble, handling noise",
    params: { frequency: num(20, 2000, 80, "The frequency", { step: 5, unit: "Hz" }) },
    filters: (p) => [`highpass=f=${n(p.frequency as number)}`],
  },
  {
    type: "lowpass", domain: "audio", group: "Tone", title: "Low-pass",
    description: "Removes what is above a frequency: hiss, or a sound heard through a wall",
    params: { frequency: num(200, 20000, 8000, "The frequency", { step: 50, unit: "Hz" }) },
    filters: (p) => [`lowpass=f=${n(p.frequency as number)}`],
  },
  {
    type: "eq", domain: "audio", group: "Tone", title: "EQ band",
    description: "One band raised or lowered",
    params: {
      frequency: num(20, 20000, 1000, "The band's centre", { step: 10, unit: "Hz" }),
      gain: num(-24, 24, 0, "Raised or lowered by", { step: 0.5, unit: "dB" }),
      q: num(0.1, 10, 1, "How narrow the band is", { step: 0.1 }),
    },
    filters: (p) => [`equalizer=f=${n(p.frequency as number)}:t=q:w=${n(p.q as number)}:g=${n(p.gain as number)}`],
  },
  {
    type: "bass", domain: "audio", group: "Tone", title: "Bass",
    description: "The low end raised or lowered",
    params: { gain: num(-20, 20, 3, "Raised or lowered by", { step: 0.5, unit: "dB" }) },
    filters: (p) => [`bass=g=${n(p.gain as number)}`],
  },
  {
    type: "treble", domain: "audio", group: "Tone", title: "Treble",
    description: "The high end raised or lowered",
    params: { gain: num(-20, 20, 3, "Raised or lowered by", { step: 0.5, unit: "dB" }) },
    filters: (p) => [`treble=g=${n(p.gain as number)}`],
  },
  {
    type: "telephone", domain: "audio", group: "Tone", title: "Telephone",
    description: "A voice heard down a line",
    params: {},
    filters: () => ["highpass=f=300", "lowpass=f=3400"],
  },
  {
    type: "compressor", domain: "audio", group: "Dynamics", title: "Compressor",
    description: "Evens out a voice: the loud parts brought down, the whole raised",
    params: {
      threshold: num(-60, 0, -18, "Above this it is brought down", { step: 0.5, unit: "dB" }),
      ratio: num(1, 20, 3, "By how much", { step: 0.1 }),
      attack: num(0.01, 2000, 15, "How fast it acts", { step: 1, unit: "ms" }),
      release: num(0.01, 9000, 180, "How fast it lets go", { step: 5, unit: "ms" }),
      makeup: num(0, 24, 2, "Raised afterwards by", { step: 0.5, unit: "dB" }),
    },
    filters: (p) => [`acompressor=threshold=${linear(p.threshold as number)}:ratio=${n(p.ratio as number)}:attack=${n(p.attack as number)}:release=${n(p.release as number)}:makeup=${linear(p.makeup as number)}`],
  },
  {
    type: "limiter", domain: "audio", group: "Dynamics", title: "Limiter",
    description: "Nothing passes a ceiling",
    params: { ceiling: num(-24, 0, -1, "The ceiling", { step: 0.1, unit: "dB" }) },
    filters: (p) => [`alimiter=limit=${linear(p.ceiling as number)}:level=disabled`],
  },
  {
    type: "gate", domain: "audio", group: "Dynamics", title: "Gate",
    description: "Silence between phrases: what is under a level is closed off",
    params: { threshold: num(-90, 0, -45, "Under this it closes", { step: 1, unit: "dB" }) },
    filters: (p) => [`agate=threshold=${linear(p.threshold as number)}`],
  },
  {
    type: "normalize", domain: "audio", group: "Dynamics", title: "Even level",
    description: "Keeps a recording at a steady level as it goes",
    params: {},
    filters: () => ["dynaudnorm=f=250:g=15"],
  },
  {
    type: "denoise", domain: "audio", group: "Repair", title: "Denoise",
    description: "Less steady background noise: hiss, hum, air",
    params: { amount: num(1, 60, 12, "Noise reduction", { step: 1, unit: "dB" }) },
    filters: (p) => [`afftdn=nr=${n(p.amount as number)}:nf=-40`],
  },
  {
    type: "deesser", domain: "audio", group: "Repair", title: "De-esser",
    description: "Softer sibilants",
    params: { intensity: num(0, 1, 0.4, "Strength", { step: 0.05 }) },
    filters: (p) => [`deesser=i=${n(p.intensity as number)}`],
  },
  {
    type: "reverb", domain: "audio", group: "Space", title: "Reverb",
    description: "Puts a dry sound in a room",
    params: {
      space: { kind: "enum", values: Object.keys(REVERBS), default: "room", description: "The room's size" },
      mix: num(0, 1, 0.3, "How much of the room is heard", { step: 0.01 }),
    },
    filters: (p) => {
      const r = REVERBS[p.space as string]!;
      const decays = r.decays.split("|").map((d) => n(Number(d) * (0.4 + 2 * (p.mix as number)))).join("|");
      return [`aecho=in_gain=1:out_gain=${n(1 - 0.25 * (p.mix as number))}:delays=${r.delays}:decays=${decays}`];
    },
  },
  {
    type: "echo", domain: "audio", group: "Space", title: "Echo",
    description: "One repeat, after a delay",
    params: {
      delay: num(20, 2000, 320, "After how long", { step: 10, unit: "ms" }),
      decay: num(0.05, 0.9, 0.35, "How loud the repeat is", { step: 0.05 }),
    },
    filters: (p) => [`aecho=in_gain=1:out_gain=0.9:delays=${n(p.delay as number)}:decays=${n(p.decay as number)}`],
  },
  {
    type: "pitch", domain: "audio", group: "Space", title: "Pitch",
    description: "Higher or lower, keeping the length",
    params: { semitones: num(-12, 12, 0, "Up or down", { step: 0.5, unit: "st" }) },
    filters: (p) => {
      const factor = Math.pow(2, (p.semitones as number) / 12);
      return [`asetrate=${n(48000 * factor)}`, "aresample=48000", ...tempoFilters(1 / factor)];
    },
  },
  {
    type: "stereo-width", domain: "audio", group: "Space", title: "Stereo width",
    description: "Narrower towards mono, or wider",
    params: { amount: num(0, 3, 1.4, "1 leaves it as it is", { step: 0.05 }) },
    filters: (p) => [`extrastereo=m=${n(p.amount as number)}`],
  },
  {
    type: "pan", domain: "audio", group: "Space", title: "Pan",
    description: "Towards the left or the right",
    params: { position: num(-1, 1, 0, "-1 is left, 1 is right", { step: 0.05 }) },
    filters: (p) => [`stereotools=balance_out=${n(p.position as number)}`],
  },
];

/** `atempo` takes 0.5 to 100: a slower tempo is a chain of them. */
export function tempoFilters(tempo: number): string[] {
  const filters: string[] = [];
  let remaining = tempo;
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-6) filters.push(`atempo=${n(remaining)}`);
  return filters;
}

const CATALOG = new Map<string, EffectDefinition>();
for (const definition of [...VIDEO, ...AUDIO]) CATALOG.set(`${definition.domain}:${definition.type}`, definition);

/** Every effect, picture first, without the function that renders it: what a form or an agent reads. */
export function listEffects(domain?: EffectDomain): Omit<EffectDefinition, "filters">[] {
  return [...VIDEO, ...AUDIO]
    .filter((definition) => !domain || definition.domain === domain)
    .map(({ filters: _filters, ...rest }) => rest);
}

export function effectDefinition(domain: EffectDomain, type: string): EffectDefinition | undefined {
  return CATALOG.get(`${domain}:${type}`);
}

/** An effect's parameters with every default filled in. Call after `validateEffect` found nothing. */
export function resolvedParams(definition: EffectDefinition, effect: EffectSpec): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [name, param] of Object.entries(definition.params)) {
    const given = effect.params?.[name];
    if (given !== undefined) out[name] = given;
    else if (param.kind !== "file") out[name] = param.default;
  }
  return out;
}

/** Problems of one effect where it is used. */
export function validateEffect(domain: EffectDomain, effect: EffectSpec, path: string): EffectProblem[] {
  const definition = effectDefinition(domain, effect.type);
  if (!definition) {
    const other = effectDefinition(domain === "video" ? "audio" : "video", effect.type);
    return [other
      ? { code: "wrong-domain", path: `${path}.type`, message: `"${effect.type}" is a ${other.domain === "video" ? "picture" : "sound"} effect` }
      : { code: "unknown-effect", path: `${path}.type`, message: `there is no ${domain === "video" ? "picture" : "sound"} effect "${effect.type}"` }];
  }
  const problems: EffectProblem[] = [];
  for (const [name, value] of Object.entries(effect.params ?? {})) {
    const param = definition.params[name];
    const at = `${path}.params.${name}`;
    if (!param) {
      problems.push({ code: "unknown-param", path: at, message: `"${effect.type}" has no parameter "${name}"` });
      continue;
    }
    if (param.kind === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) problems.push({ code: "bad-param", path: at, message: "must be a number" });
      else if (value < param.min || value > param.max) problems.push({ code: "bad-param", path: at, message: `must be between ${param.min} and ${param.max}` });
    } else if (param.kind === "enum") {
      if (typeof value !== "string" || !param.values.includes(value)) problems.push({ code: "bad-param", path: at, message: `must be one of ${param.values.join(", ")}` });
    } else if (param.kind === "boolean") {
      if (typeof value !== "boolean") problems.push({ code: "bad-param", path: at, message: "must be true or false" });
    } else if (param.kind === "color") {
      if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) problems.push({ code: "bad-param", path: at, message: "must be a colour as #rrggbb" });
    } else if (typeof value !== "string" || !param.extensions.some((ext) => value.toLowerCase().endsWith(ext))) {
      problems.push({ code: "bad-param", path: at, message: `must be a ${param.extensions.join(" or ")} file` });
    }
  }
  for (const [name, param] of Object.entries(definition.params)) {
    if (param.kind === "file" && effect.params?.[name] === undefined) {
      problems.push({ code: "missing-param", path: `${path}.params.${name}`, message: `"${effect.type}" needs "${name}"` });
    }
  }
  return problems;
}

/** The filters of a list of effects, in order; disabled ones left out. */
export function effectFilters(domain: EffectDomain, effects: readonly EffectSpec[] | undefined, context: EffectContext): string[] {
  const filters: string[] = [];
  for (const effect of effects ?? []) {
    if (effect.enabled === false) continue;
    const definition = effectDefinition(domain, effect.type);
    if (!definition) throw new Error(`there is no ${domain} effect "${effect.type}"`);
    filters.push(...definition.filters(resolvedParams(definition, effect), context));
  }
  return filters;
}

/** The files a list of effects reads (a LUT), as the paths FFmpeg opens. */
export function effectFiles(domain: EffectDomain, effects: readonly EffectSpec[] | undefined, resolveFile: (file: string) => string): string[] {
  const files: string[] = [];
  for (const effect of effects ?? []) {
    if (effect.enabled === false) continue;
    const definition = effectDefinition(domain, effect.type);
    for (const [name, param] of Object.entries(definition?.params ?? {})) {
      const value = effect.params?.[name];
      if (param.kind === "file" && typeof value === "string") files.push(resolveFile(value));
    }
  }
  return files;
}

/** Whether any enabled effect of the list makes the picture transparent. */
export function effectsNeedAlpha(effects: readonly EffectSpec[] | undefined): boolean {
  return (effects ?? []).some((effect) => effect.enabled !== false && effectDefinition("video", effect.type)?.alpha === true);
}
