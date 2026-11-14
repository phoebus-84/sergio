// ---------------------------------------------------------------------------
// A talking presenter: one photo and one voice recording to a video
// ---------------------------------------------------------------------------
// `pva_generate_avatar_speech` gives MiniMax H3 Max lip-sync (through fal) a
// picture of a person and an audio file, and gets back that person saying it.
// The video is as long as the audio, and is priced per second of it.
//
// Shaped like `pva_generate_wan_video`: paths are guarded, the call goes
// through fal's queue via @av/fal-media, it is reserved and settled on the
// episode's spend ledger (avg-91o), and the clip lands under the episode with
// a provenance sidecar. What differs:
//
// - the picture may live in a channel source (library/<channel>/sources/<name>),
//   where a presenter's look photos are kept for every episode to share;
// - the audio is a file, so both inputs are uploaded to fal's storage rather
//   than inlined;
// - the audio is measured here first: its length sets the price, and a length
//   the endpoint does not take is refused before anything is sent.
//
// Every number — prices, resolutions, the length limits, the long-video
// surcharge, the picture's shape — is read from the profile in @av/fal-media.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  createFalClient,
  FalHttpError,
  FalValidationError,
  H3_MAX_LIP_SYNC,
  h3MaxLipSyncPriceUsd,
  minimaxH3MaxLipSync,
  type H3MaxLipSyncResolution,
} from "@av/fal-media";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { episodePath } from "@studio/contracts/src/layout.mjs";
import { resolveConfig } from "./config.js";
import { guardEpisodePath } from "./trust-guards.js";
import { guardWorkspacePath, workspaceOf } from "./workspace-target.js";
import { paidCall, providerCost } from "./spend.js";

export const AVATAR_SPEECH_TOOL = "pva_generate_avatar_speech";
export const AVATAR_PROFILE = minimaxH3MaxLipSync;
export const AVATAR_RESOLUTIONS = Object.keys(H3_MAX_LIP_SYNC.pricesPerSecondUsd) as [H3MaxLipSyncResolution, ...H3MaxLipSyncResolution[]];

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const HEARTBEAT_MS = 15_000;
const MAX_WAIT_MS = 900_000;
const IMAGE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const AUDIO_TYPES: Readonly<Record<string, string>> = { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4" };

const usd = (amount: number) => `$${Number(amount.toFixed(4))}`;

/** "480P $0.05, 768P $0.08, …" — the profile's prices, for descriptions and messages. */
export function avatarPriceList(): string {
  return AVATAR_RESOLUTIONS.map((r) => `${r} ${usd(H3_MAX_LIP_SYNC.pricesPerSecondUsd[r])}`).join(", ");
}

/** What the tool says about its price and limits, from the profile. */
export function avatarTerms(): string {
  const { longVideo, audioSeconds } = H3_MAX_LIP_SYNC;
  return `per second of audio: ${avatarPriceList()}; ×${longVideo.priceMultiplier} when the audio is longer than ${longVideo.overSeconds} s; ` +
    `audio ${audioSeconds.min}–${audioSeconds.max} s`;
}

export interface AvatarRequest {
  imageUrl: string;
  audioUrl: string;
  resolution: H3MaxLipSyncResolution;
  seed: number;
  enableTranscription?: boolean;
}

/** The request body fal's lip-sync endpoint takes, from the tool's parameters. */
export function avatarRequestBody(r: AvatarRequest): Record<string, unknown> {
  return {
    image_url: r.imageUrl,
    audio_url: r.audioUrl,
    resolution: r.resolution,
    seed: r.seed,
    ...(r.enableTranscription === undefined ? {} : { enable_transcription: r.enableTranscription }),
    enable_safety_checker: true,
  };
}

/** Why an audio length cannot be sent, or null when it can. Limits are the profile's. */
export function avatarAudioProblem(seconds: number): string | null {
  const { min, max } = H3_MAX_LIP_SYNC.audioSeconds;
  const length = `${seconds.toFixed(2)} s`;
  if (seconds < min) return `the audio is ${length} long; lip-sync needs at least ${min} s: join it with the next line, or add room tone, then try again`;
  if (seconds > max) return `the audio is ${length} long; one call takes at most ${max} s: cut it at a pause into parts of ${min}–${max} s and make one clip per part`;
  return null;
}

/** Why a picture's shape cannot be sent, or null when it can. */
export function avatarImageProblem(width: number, height: number): string | null {
  const { min, max } = H3_MAX_LIP_SYNC.imageAspectRatio;
  const ratio = width / height;
  if (ratio >= min && ratio <= max) return null;
  return `the image is ${width}×${height} (width/height ${ratio.toFixed(2)}); lip-sync takes ${min}–${max}: crop it first`;
}

interface Measured { durationSeconds?: number; width?: number; height?: number }

/** A file's length and frame size by ffprobe. */
function measure(file: string): Promise<Measured> {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.FFPROBE_PATH || "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file],
      { windowsHide: true, timeout: 30_000 },
      (error, stdout) => {
        if (error) return reject(new Error(`ffprobe could not read ${basename(file)}: ${error.message.split("\n")[0]}`));
        try {
          const data = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
          const picture = data.streams?.find((s) => s.width && s.height);
          const duration = Number(data.format?.duration);
          resolve({
            ...(picture ? { width: picture.width!, height: picture.height! } : {}),
            ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
          });
        } catch {
          reject(new Error(`ffprobe gave no measurements for ${basename(file)}`));
        }
      },
    );
  });
}

export function registerAvatarTools(pi: ExtensionAPI): void {
  const LIBRARY_ROOT = process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");
  const profile = AVATAR_PROFILE;
  const defaultResolution = H3_MAX_LIP_SYNC.defaultResolution;

  pi.registerTool({
    name: AVATAR_SPEECH_TOOL,
    label: "Generate Avatar Speech",
    description:
      "Make a person in a photo say an audio file: MiniMax H3 Max lip-sync through fal.ai (photo + audio → talking video, " +
      `as long as the audio). Paid, ${avatarTerms()}; reserved on the episode's spend ledger at price × the audio's length. ` +
      "The photo is an episode file, or with imageSource a file of a channel source (library/<channel>/sources/<name>), " +
      "where a presenter's look photos are shared by every episode. " +
      "Saves assets/video/<shotId>.mp4 and <shotId>.provenance.json in the episode. Check pva_budget_status first.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel slug" }),
      series: Type.String({ description: "Series slug" }),
      episode: Type.String({ description: "Episode slug" }),
      shotId: Type.String({ description: "Safe clip name (letters, digits, _ and -), the MP4's filename" }),
      imagePath: Type.String({ description: "The photo of the person (png, jpg or webp): episode-relative, or relative to the source when imageSource is given" }),
      imageSource: Type.Optional(Type.String({ description: "A channel source's name: imagePath is then read from library/<channel>/sources/<name>/" })),
      audioPath: Type.String({ description: `Episode-relative audio the person says (wav, mp3 or m4a), ${H3_MAX_LIP_SYNC.audioSeconds.min}–${H3_MAX_LIP_SYNC.audioSeconds.max} s` }),
      resolution: Type.Optional(StringEnum(AVATAR_RESOLUTIONS, { default: defaultResolution, description: `Sets the price per second: ${avatarPriceList()}` })),
      seed: Type.Optional(Type.Integer({ minimum: 0, description: "Omitted: one is picked and recorded" })),
      enableTranscription: Type.Optional(Type.Boolean({ description: "Let the model transcribe the audio to guide the mouth (the endpoint's default: on)" })),
      overwrite: Type.Optional(Type.Boolean({ default: false, description: "Replace an existing clip of this shotId" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      if (!SAFE_NAME.test(params.shotId)) {
        throw new Error("shotId must contain only letters, numbers, underscores and hyphens (max 64)");
      }
      const dir = episodePath(LIBRARY_ROOT, params.channel, params.series, params.episode);

      // The photo: in the episode, or in a channel source.
      let imageFull: string;
      if (params.imageSource !== undefined) {
        const source = workspaceOf(LIBRARY_ROOT, { channel: params.channel, source: params.imageSource });
        const guard = await guardWorkspacePath(LIBRARY_ROOT, source, params.imagePath);
        if (!guard.allowed) throw new Error(guard.reason ?? `Image path rejected: ${params.imagePath}`);
        imageFull = join(source.dir, params.imagePath);
      } else {
        const guard = await guardEpisodePath(LIBRARY_ROOT, params.channel, params.series, params.episode, params.imagePath);
        if (!guard.allowed) throw new Error(guard.reason ?? `Image path rejected: ${params.imagePath}`);
        imageFull = join(dir, params.imagePath);
      }
      const imageLabel = params.imageSource !== undefined ? `sources/${params.imageSource}/${params.imagePath}` : params.imagePath;
      if (!existsSync(imageFull) || !statSync(imageFull).isFile()) throw new Error(`Image not found: ${imageLabel}`);
      const imageType = IMAGE_TYPES[extname(imageFull).toLowerCase()];
      if (!imageType) throw new Error(`Unsupported image type: ${extname(imageFull) || "no extension"} (png, jpg or webp)`);

      const audioGuard = await guardEpisodePath(LIBRARY_ROOT, params.channel, params.series, params.episode, params.audioPath);
      if (!audioGuard.allowed) throw new Error(audioGuard.reason ?? `Audio path rejected: ${params.audioPath}`);
      const audioFull = join(dir, params.audioPath);
      if (!existsSync(audioFull) || !statSync(audioFull).isFile()) throw new Error(`Audio not found: ${params.audioPath}`);
      const audioType = AUDIO_TYPES[extname(audioFull).toLowerCase()];
      if (!audioType) throw new Error(`Unsupported audio type: ${extname(audioFull) || "no extension"} (wav, mp3 or m4a)`);

      const videoDir = join(dir, "assets", "video");
      const outputPath = join(videoDir, `${params.shotId}.mp4`);
      const provenancePath = join(videoDir, `${params.shotId}.provenance.json`);
      // Before anything is spent: a name already taken is a mistake more often than a retake.
      if (existsSync(outputPath) && !params.overwrite) {
        throw new Error(`assets/video/${params.shotId}.mp4 already exists: pick another shotId, or pass overwrite: true`);
      }

      const resolution: H3MaxLipSyncResolution = params.resolution ?? defaultResolution;
      if (!AVATAR_RESOLUTIONS.includes(resolution)) throw new Error(`lip-sync does not offer ${String(resolution)}: ${AVATAR_RESOLUTIONS.join(", ")}`);

      // Measured here, before any request: the audio's length is the video's, and the price's.
      const audioSeconds = (await measure(audioFull)).durationSeconds;
      if (audioSeconds === undefined) throw new Error(`${params.audioPath} has no duration ffprobe can read`);
      const audioProblem = avatarAudioProblem(audioSeconds);
      if (audioProblem) throw new Error(`${params.audioPath}: ${audioProblem}`);
      const picture = await measure(imageFull);
      if (!picture.width || !picture.height) throw new Error(`${imageLabel} is not a picture ffprobe can read`);
      const imageProblem = avatarImageProblem(picture.width, picture.height);
      if (imageProblem) throw new Error(`${imageLabel}: ${imageProblem}`);

      const config = await resolveConfig();
      if (!config.falKeyRef) throw new Error("FAL_KEY env var not set");

      const imageBytes = readFileSync(imageFull);
      const audioBytes = readFileSync(audioFull);
      const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
      const audioSha256 = createHash("sha256").update(audioBytes).digest("hex");
      // fal does not report the seed through the client's result, so pick it
      // here: the provenance then always says how to make the same clip again.
      const seed = params.seed ?? randomInt(0, 2 ** 31 - 1);
      const settings = {
        resolution,
        seed,
        ...(params.enableTranscription === undefined ? {} : { enableTranscription: params.enableTranscription }),
      };
      const requestHash = createHash("sha256")
        .update(JSON.stringify({ ...settings, imageSha256, audioSha256 }))
        .digest("hex")
        .slice(0, 20);

      const priceUsd = h3MaxLipSyncPriceUsd(resolution, audioSeconds);
      const what = `${params.shotId} (${resolution}, ${audioSeconds.toFixed(1)} s, ~${usd(priceUsd)})`;
      onUpdate?.({
        content: [{ type: "text" as const, text: `Submitting ${what} to MiniMax H3 Max lip-sync…` }],
        details: { shotId: params.shotId, profileId: profile.profileId },
      });

      const client = createFalClient(config.falKeyRef);
      const startedMs = Date.now();
      const heartbeat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text" as const, text: `Avatar ${params.shotId}: waiting on fal… ${Math.round((Date.now() - startedMs) / 1000)}s` }],
          details: { shotId: params.shotId, elapsedMs: Date.now() - startedMs },
        });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      let result;
      try {
        // Through the episode's spend ledger (avg-91o), reserved at this
        // resolution's price for this audio's length, settled at what fal reports.
        result = await paidCall(
          { libraryRoot: LIBRARY_ROOT, channel: params.channel, series: params.series, episode: params.episode },
          {
            capability: "video.generate",
            provider: "fal",
            model: profile.profileId,
            purpose: `avatar ${params.shotId}`,
            estimate: {
              estimate: { currency: "USD", micros: toMicros(priceUsd) },
              priced: true,
              profile: profile.profileId,
            },
          },
          async (spend) => {
            try {
              // Uploads are free and come first: if one fails, nothing was generated.
              const imageUrl = await client.uploadFile({ bytes: imageBytes, fileName: `image${extname(imageFull).toLowerCase()}`, contentType: imageType }, signal);
              const audioUrl = await client.uploadFile({ bytes: audioBytes, fileName: `audio${extname(audioFull).toLowerCase()}`, contentType: audioType }, signal);
              spend.sending();
              const generated = await client.submitAndWait({
                idempotencyKey: `${params.channel}-${params.series}-${params.episode}-${params.shotId}-${requestHash}`,
                binding: { endpointId: profile.endpointId, contractVersion: profile.contractVersion, baseUrl: "" },
                parameters: avatarRequestBody({ imageUrl, audioUrl, ...settings }),
                timeoutMs: MAX_WAIT_MS,
              }, signal, { maxWaitMs: MAX_WAIT_MS });
              return { value: generated, cost: providerCost(generated.cost), providerRequestId: generated.providerRequestId };
            } catch (e) {
              // Refused before submit, or by fal with a 4xx: nothing generated.
              // Anything else may have been billed and stays reserved.
              if (e instanceof FalValidationError || (e instanceof FalHttpError && e.status >= 400 && e.status < 500 && e.status !== 429)) {
                spend.refused();
              }
              throw e;
            }
          },
        );
      } finally {
        clearInterval(heartbeat);
      }

      const output = result.outputs.find((o) => o.contentType.startsWith("video/")) ?? result.outputs[0];
      if (!output) throw new Error("MiniMax H3 Max lip-sync completed without a video output");
      const download = await fetch(output.url, { signal });
      if (!download.ok) throw new Error(`Failed to download the avatar clip (fal request ${result.providerRequestId}): HTTP ${download.status}`);
      const data = Buffer.from(await download.arrayBuffer());

      mkdirSync(videoDir, { recursive: true });
      writeFileSync(outputPath, data);
      const provenance = {
        version: 1,
        provider: "fal.ai",
        model: "MiniMax H3 Max lip-sync image-to-video",
        endpointId: profile.endpointId,
        profileId: result.profileId,
        schemaFingerprint: result.schemaFingerprint,
        providerRequestId: result.providerRequestId,
        idempotencyKey: result.idempotencyKey,
        shotId: params.shotId,
        imagePath: params.imagePath,
        ...(params.imageSource !== undefined ? { imageSource: params.imageSource } : {}),
        imageSha256,
        imageSize: { width: picture.width, height: picture.height },
        audioPath: params.audioPath,
        audioSha256,
        audioDurationSeconds: audioSeconds,
        resolution,
        seed,
        ...(params.enableTranscription === undefined ? {} : { enableTranscription: params.enableTranscription }),
        estimatedCost: { amount: priceUsd, currency: "USD" },
        cost: result.cost,
        outputUrl: output.url,
        outputSha256: createHash("sha256").update(data).digest("hex"),
        completedAt: result.completedAt.toISOString(),
      };
      writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

      return {
        content: [{
          type: "text" as const,
          text: `✅ assets/video/${params.shotId}.mp4 — ${(data.length / 1024 / 1024).toFixed(1)}MB, ${audioSeconds.toFixed(1)} s at ${resolution}, seed ${seed}, ` +
            `${result.cost ? `$${result.cost.amount}` : `~${usd(priceUsd)}`} (${result.profileId})`,
        }],
        details: {
          outputPath,
          provenancePath,
          size: data.length,
          profileId: result.profileId,
          providerRequestId: result.providerRequestId,
          seed,
          resolution,
          audioDurationSeconds: audioSeconds,
          cost: result.cost,
          estimatedCostUsd: priceUsd,
        },
      };
    },
  });
}
