// Frames a Blender script rendered, joined into one H.264 file with no sound.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./process.js";

export async function nonempty(file: string): Promise<void> {
  const found = await stat(file).catch(() => null);
  if (!found?.isFile() || found.size === 0) throw new Error(`Missing or empty output: ${file}`);
}

/**
 * `frames/000001.png` … in `outputDir`, as `shot.mp4` beside them. The first
 * and the last frame are checked first: a script that stopped early is not
 * given a file.
 */
export async function joinFrames(
  outputDir: string,
  shot: { frames: number; fps: number },
  options: { ffmpegPath?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  for (const frame of [1, shot.frames]) await nonempty(join(outputDir, "frames", `${String(frame).padStart(6, "0")}.png`));
  const mediaPath = join(outputDir, "shot.mp4");
  await runProcess(options.ffmpegPath ?? process.env.FFMPEG_BIN ?? "ffmpeg", [
    "-hide_banner", "-nostdin", "-n", "-framerate", String(shot.fps), "-start_number", "1", "-i", join(outputDir, "frames", "%06d.png"),
    "-frames:v", String(shot.frames), "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mediaPath,
  ], { cwd: outputDir, logPath: join(outputDir, "encode.log"), timeoutMs: options.timeoutMs, signal: options.signal });
  await nonempty(mediaPath);
  return mediaPath;
}
