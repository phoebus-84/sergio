// ---------------------------------------------------------------------------
// A rigged character, filmed
// ---------------------------------------------------------------------------
// `pva_rig_shot` is where a character becomes footage. Until it existed the
// studio kept a rig, pinned it and could not show it: getting one into a
// film meant a Blender script the agent wrote by hand, each time.
//
// A rig and one of its clips go in; a clip of video comes out in
// assets/video/, as every generated clip does, lit on a plain ground and
// seen by a camera asked for in the words a shot is described in. Local
// (Blender and FFmpeg), free, and the same request gives the same frames.
// It is one character on an empty stage: a scene with a set, two characters
// or a moving camera is still built in Blender (blender-scene).
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { RIG_SHOT_DEFAULTS, RIG_SHOT_LIMITS, SHOT_CAMERAS, SHOT_FRAMINGS, rigShot, shotSettings, type ShotCamera, type ShotFraming } from "@av/blender/rig-shot";
import { RIG_FACINGS, type RigFacing } from "@av/blender/rig-sheet";
import { episodePath } from "@studio/contracts/src/layout.mjs";
import { guardEpisodePath } from "./trust-guards.js";

export const RIG_SHOT_TOOL = "pva_rig_shot";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function registerRigShotTools(pi: ExtensionAPI): void {
  const LIBRARY_ROOT = process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");

  pi.registerTool({
    name: RIG_SHOT_TOOL,
    label: "Film a Rigged Character",
    description:
      "Film a rigged 3D character playing one of its clips: a clip of video in the episode, with no sound. Local (Blender and FFmpeg), free, repeatable. " +
      "The character stands lit on a plain ground; the camera is asked for in words — `camera` front, three-quarter, side or back; `framing` full (the whole body), medium (waist up) or close (head and shoulders) — " +
      "and keeps the body in frame as it travels unless `follow` is false. `clip` names one of the rig's clips (<rig>.clip.<name>.glb); without it the body stands at rest. " +
      "It plays the clip once, or `loops` times, or for `seconds` (a clip that travels jumps back when it repeats: loop one that is played on the spot). " +
      "Saves assets/video/<shotId>.mp4 and <shotId>.provenance.json, as generated clips are kept, to be placed on the timeline or in a cut like any other. " +
      "One character on an empty stage: a set, two characters together or a camera that moves on its own are a Blender scene (blender-scene skill). " +
      "A rig from pva_rig_model faces +z. Look at the result before it is used: pva_inspect_media.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel slug" }),
      series: Type.String({ description: "Series slug" }),
      episode: Type.String({ description: "Episode slug" }),
      shotId: Type.String({ description: "Safe name (letters, digits, _ and -) for the clip of video" }),
      rigPath: Type.String({ description: "The rig, episode-relative: assets/models/<rigId>.glb" }),
      clip: Type.Optional(Type.String({ description: "One of the rig's clips, by name: the <name> of <rig>.clip.<name>.glb. Without it the character stands at rest" })),
      camera: Type.Optional(StringEnum(SHOT_CAMERAS as unknown as [ShotCamera, ...ShotCamera[]], { default: RIG_SHOT_DEFAULTS.camera, description: "Where the camera stands, seen from the body" })),
      framing: Type.Optional(StringEnum(SHOT_FRAMINGS as unknown as [ShotFraming, ...ShotFraming[]], { default: RIG_SHOT_DEFAULTS.framing, description: "full: the whole body. medium: from the waist up. close: head and shoulders" })),
      follow: Type.Optional(Type.Boolean({ default: true, description: "The camera keeps the body in frame as it travels. false: the camera stays and the body may walk out" })),
      seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: RIG_SHOT_LIMITS.seconds, description: "How long. Default: the clip once, or two seconds for a body at rest" })),
      loops: Type.Optional(Type.Integer({ minimum: 1, maximum: RIG_SHOT_LIMITS.loops, description: "How many times the clip is played, when seconds is not given" })),
      width: Type.Optional(Type.Integer({ minimum: RIG_SHOT_LIMITS.side[0], maximum: RIG_SHOT_LIMITS.side[1], description: `Even. Default ${RIG_SHOT_DEFAULTS.width}` })),
      height: Type.Optional(Type.Integer({ minimum: RIG_SHOT_LIMITS.side[0], maximum: RIG_SHOT_LIMITS.side[1], description: `Even. Default ${RIG_SHOT_DEFAULTS.height}; 1080 × 1920 for a vertical film` })),
      fps: Type.Optional(Type.Integer({ minimum: RIG_SHOT_LIMITS.fps[0], maximum: RIG_SHOT_LIMITS.fps[1], description: `Default ${RIG_SHOT_DEFAULTS.fps}: use the film's` })),
      background: Type.Optional(Type.String({ description: `What is behind the character, as #rrggbb. Default ${RIG_SHOT_DEFAULTS.background}` })),
      ground: Type.Optional(Type.Boolean({ default: true, description: "A floor that takes the character's shadow. false: the character on the bare colour" })),
      faces: Type.Optional(StringEnum(RIG_FACINGS as unknown as [RigFacing, ...RigFacing[]], { default: "+z", description: "Which way the body faces in its file" })),
      overwrite: Type.Optional(Type.Boolean({ default: false, description: "Replace an existing clip of video of this shotId" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      if (!SAFE_NAME.test(params.shotId)) throw new Error("shotId must contain only letters, numbers, underscores and hyphens (max 64)");
      const dir = episodePath(LIBRARY_ROOT, params.channel, params.series, params.episode);
      const guard = await guardEpisodePath(LIBRARY_ROOT, params.channel, params.series, params.episode, params.rigPath);
      if (!guard.allowed) throw new Error(guard.reason ?? `Rig path rejected: ${params.rigPath}`);
      const rigFull = join(dir, params.rigPath);
      if (!existsSync(rigFull) || !statSync(rigFull).isFile()) throw new Error(`Rig not found: ${params.rigPath}`);
      if (!/\.glb$/i.test(rigFull)) throw new Error(`Rig must be a binary glTF (.glb): ${params.rigPath}`);
      let filmed = rigFull;
      if (params.clip !== undefined) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(params.clip)) throw new Error("clip is the name of one of the rig's clips: letters, digits, dots, underscores and hyphens");
        filmed = join(dirname(rigFull), `${basename(rigFull).replace(/\.glb$/i, "")}.clip.${params.clip}.glb`);
        if (!existsSync(filmed)) throw new Error(`the rig has no clip named ${params.clip}: ${relative(dir, filmed)} is not there`);
      }
      const videoDir = join(dir, "assets", "video");
      const videoFull = join(videoDir, `${params.shotId}.mp4`);
      if (existsSync(videoFull) && !params.overwrite) throw new Error(`assets/video/${params.shotId}.mp4 already exists: pick another shotId, or pass overwrite: true`);
      const request = {
        path: filmed,
        ...(params.faces ? { faces: params.faces } : {}), ...(params.camera ? { camera: params.camera } : {}), ...(params.framing ? { framing: params.framing } : {}),
        ...(params.follow !== undefined ? { follow: params.follow } : {}), ...(params.seconds !== undefined ? { seconds: params.seconds } : {}),
        ...(params.loops !== undefined ? { loops: params.loops } : {}), ...(params.width !== undefined ? { width: params.width } : {}),
        ...(params.height !== undefined ? { height: params.height } : {}), ...(params.fps !== undefined ? { fps: params.fps } : {}),
        ...(params.background ? { background: params.background } : {}), ...(params.ground !== undefined ? { ground: params.ground } : {}),
      };
      // Refused here, before Blender is started and a work folder made.
      const settings = shotSettings({ ...request, outputDir: "" });

      onUpdate?.({ content: [{ type: "text" as const, text: `Filming ${relative(dir, filmed)} in Blender…` }], details: { shotId: params.shotId } });
      const work = mkdtempSync(join(tmpdir(), "rig-shot-"));
      try {
        const { report, mediaPath } = await rigShot({ ...request, outputDir: join(work, "shot") }, signal ? { signal } : {});
        mkdirSync(videoDir, { recursive: true });
        copyFileSync(mediaPath, videoFull);
        const bytes = readFileSync(videoFull);
        const provenancePath = join(videoDir, `${params.shotId}.provenance.json`);
        writeFileSync(provenancePath, `${JSON.stringify({
          version: 1, tool: RIG_SHOT_TOOL, file: `${params.shotId}.mp4`, sha256: sha256(bytes), bytes: bytes.length,
          rig: params.rigPath, rigSha256: sha256(readFileSync(rigFull)),
          ...(params.clip !== undefined ? { clip: params.clip, clipFile: relative(dir, filmed), clipSha256: sha256(readFileSync(filmed)) } : {}),
          settings, ...report, madeAt: new Date().toISOString(),
        }, null, 2)}\n`);
        const moved = report.travel < 0.1 ? "on the spot" : `travelling ${report.travel} of its height${report.follow ? ", the camera with it" : ", past a camera that stays"}`;
        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ assets/video/${params.shotId}.mp4 — ${report.seconds}s, ${report.width}×${report.height} at ${report.fps} fps, ${(bytes.length / 1024 / 1024).toFixed(1)}MB, no sound`,
              `   ${report.camera}, ${report.framing}; ` + (report.action ? `the clip ${params.clip} (${report.clipSeconds}s) played ${moved}` : "the character at rest: name a `clip` to see it move"),
              ...(report.action && report.seconds > report.clipSeconds * 1.05 && report.travel >= 0.1 ? ["   ⚠️ the clip travels and is played more than once: the body jumps back each time it repeats"] : []),
              "   look at it before it is used (pva_inspect_media): a body that leaves the frame, a hand through the head, a floor it sinks into are seen, not measured",
            ].join("\n"),
          }],
          details: { outputPath: videoFull, provenancePath, report } as unknown as Record<string, unknown>,
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  });
}
