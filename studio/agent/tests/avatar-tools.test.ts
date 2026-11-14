// ---------------------------------------------------------------------------
// pva_generate_avatar_speech: MiniMax H3 Max lip-sync on fal, through the
// spend ledger
// ---------------------------------------------------------------------------
// The real tool against a stubbed `fetch`: fal's storage (initiate, upload),
// its queue (submit, status, result) and the CDN are all fakes, so nothing
// leaves the machine and nothing is spent. The audio and the pictures are
// real files made by ffmpeg, because the tool measures them.
//
// Every expected number is computed from the profile in @av/fal-media: the
// tool holds no price or limit of its own, and neither does this test.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { H3_MAX_LIP_SYNC, h3MaxLipSyncPriceUsd, minimaxH3MaxLipSync } from "@av/fal-media";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { parseJournal, JOURNAL_RELATIVE_PATH } from "@studio/contracts/src/journal.mjs";
import {
  AVATAR_RESOLUTIONS,
  avatarAudioProblem,
  avatarImageProblem,
  avatarRequestBody,
  avatarTerms,
  registerAvatarTools,
} from "../src/avatar-tools.js";
import { videoGenerationStatus } from "../src/capability-status.js";

const CHANNEL = "sample-channel";
const SERIES = "sample-series";
const EPISODE = "ep";
const SOURCE = "presenter-looks";
const QUEUE = `https://queue.fal.run/${minimaxH3MaxLipSync.endpointId}`;
const { audioSeconds, longVideo, defaultResolution, pricesPerSecondUsd } = H3_MAX_LIP_SYNC;
/** Lengths on each side of the profile's limits. */
const OK_SECONDS = audioSeconds.min + 1;
const LONG_SECONDS = longVideo.overSeconds + 5;
const TOO_SHORT_SECONDS = audioSeconds.min - 2;
const TOO_LONG_SECONDS = audioSeconds.max + 1;

interface Tool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

let fixtures: string;
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const tone = (name: string, seconds: number) => {
  ffmpeg(["-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`, "-ar", "8000", "-ac", "1", join(fixtures, name)]);
};
const picture = (name: string, size: string) => {
  ffmpeg(["-f", "lavfi", "-i", `color=c=gray:s=${size}`, "-frames:v", "1", join(fixtures, name)]);
};

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "pva-avatar-fixtures-"));
  tone("line.wav", OK_SECONDS);
  tone("long.wav", LONG_SECONDS);
  tone("short.wav", TOO_SHORT_SECONDS);
  tone("endless.wav", TOO_LONG_SECONDS);
  picture("look.png", "180x320");
  // Wider than the profile allows.
  picture("banner.png", `${Math.ceil(100 * H3_MAX_LIP_SYNC.imageAspectRatio.max) + 100}x100`);
});
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

describe("what the tool says and asks, from the profile", () => {
  it("offers the profile's resolutions and states its prices and limits", () => {
    expect(AVATAR_RESOLUTIONS).toEqual(Object.keys(pricesPerSecondUsd));
    const terms = avatarTerms();
    for (const [resolution, price] of Object.entries(pricesPerSecondUsd)) expect(terms).toContain(`${resolution} $${price}`);
    expect(terms).toContain(`×${longVideo.priceMultiplier}`);
    expect(terms).toContain(`${longVideo.overSeconds} s`);
    expect(terms).toContain(`${audioSeconds.min}–${audioSeconds.max} s`);
  });

  it("maps its parameters onto fal's schema", () => {
    expect(avatarRequestBody({ imageUrl: "https://f/i.png", audioUrl: "https://f/a.wav", resolution: defaultResolution, seed: 4, enableTranscription: false })).toEqual({
      image_url: "https://f/i.png",
      audio_url: "https://f/a.wav",
      resolution: defaultResolution,
      seed: 4,
      enable_transcription: false,
      enable_safety_checker: true,
    });
    expect(avatarRequestBody({ imageUrl: "i", audioUrl: "a", resolution: defaultResolution, seed: 1 })).not.toHaveProperty("enable_transcription");
  });

  it("refuses lengths and shapes outside the profile's limits, saying what to do", () => {
    expect(avatarAudioProblem(audioSeconds.min)).toBeNull();
    expect(avatarAudioProblem(audioSeconds.max)).toBeNull();
    expect(avatarAudioProblem(audioSeconds.min - 0.5)).toContain(`at least ${audioSeconds.min} s`);
    expect(avatarAudioProblem(audioSeconds.max + 0.5)).toContain(`at most ${audioSeconds.max} s`);
    expect(avatarImageProblem(720, 1280)).toBeNull();
    expect(avatarImageProblem(100, 1000)).toContain("crop it first");
  });

  it("is reported by the capability status, ready only with FAL_KEY", () => {
    expect(videoGenerationStatus(true)["avatar-speech"]).toMatchObject({ available: true, detail: expect.stringContaining("pva_generate_avatar_speech") });
    expect(videoGenerationStatus(false)["avatar-speech"]).toEqual({ available: false, detail: "FAL_KEY not set" });
  });
});

describe("pva_generate_avatar_speech", () => {
  let root: string;
  let dir: string;
  let previous: { root?: string; fal?: string };
  let fetchMock: ReturnType<typeof vi.fn>;
  let tool: Tool;
  let submitted: Record<string, unknown> | undefined;
  let uploads: { name: string; type: string; bytes: number }[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pva-avatar-"));
    dir = join(root, CHANNEL, "series", SERIES, "episodes", EPISODE);
    mkdirSync(join(dir, "journal"), { recursive: true });
    mkdirSync(join(dir, "artifacts", "narration"), { recursive: true });
    mkdirSync(join(dir, "assets", "images"), { recursive: true });
    mkdirSync(join(root, CHANNEL, "sources", SOURCE, "looks"), { recursive: true });
    for (const name of ["line.wav", "long.wav", "short.wav", "endless.wav"]) copyFileSync(join(fixtures, name), join(dir, "artifacts", "narration", name));
    copyFileSync(join(fixtures, "look.png"), join(dir, "assets", "images", "look.png"));
    copyFileSync(join(fixtures, "banner.png"), join(dir, "assets", "images", "banner.png"));
    copyFileSync(join(fixtures, "look.png"), join(root, CHANNEL, "sources", SOURCE, "looks", "studio.png"));
    previous = { root: process.env.AVG_LIBRARY_ROOT, fal: process.env.FAL_KEY };
    process.env.AVG_LIBRARY_ROOT = root;
    process.env.FAL_KEY = "fal-key-for-tests";
    submitted = undefined;
    uploads = [];

    fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
      if (url.includes("/storage/upload/initiate") && init?.method === "POST") {
        const asked = JSON.parse(init.body as string) as { file_name: string; content_type: string };
        return Response.json({ upload_url: `https://bucket.example/put/${asked.file_name}`, file_url: `https://files.example/${asked.file_name}` });
      }
      if (url.startsWith("https://bucket.example/put/") && init?.method === "PUT") {
        uploads.push({ name: url.split("/").pop()!, type: init.headers!["content-type"]!, bytes: (init.body as Uint8Array).byteLength });
        return new Response("", { status: 200 });
      }
      if (url === QUEUE && init?.method === "POST") {
        submitted = JSON.parse(init.body as string);
        return Response.json({
          request_id: "req-123",
          status_url: `${QUEUE}/requests/req-123/status`,
          response_url: `${QUEUE}/requests/req-123`,
        });
      }
      if (url.endsWith("/requests/req-123/status")) return Response.json({ status: "COMPLETED" });
      if (url.endsWith("/requests/req-123")) {
        return Response.json({ video: { url: "https://cdn.example/avatar.mp4", content_type: "video/mp4" }, seed: 7, duration: OK_SECONDS });
      }
      if (url === "https://cdn.example/avatar.mp4") return new Response(Buffer.from("mp4 bytes"), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tools: Tool[] = [];
    registerAvatarTools({ registerTool: (t: Tool) => tools.push(t) } as never);
    tool = tools.find((t) => t.name === "pva_generate_avatar_speech")!;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previous.root === undefined) delete process.env.AVG_LIBRARY_ROOT; else process.env.AVG_LIBRARY_ROOT = previous.root;
    if (previous.fal === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = previous.fal;
    rmSync(root, { recursive: true, force: true });
  });

  const budget = (limitMicros: number) => writeFileSync(
    join(root, CHANNEL, "series", SERIES, "settings.yaml"),
    `budget:\n  currency: USD\n  limitMicros: ${limitMicros}\n`,
  );
  const journal = () => existsSync(join(dir, JOURNAL_RELATIVE_PATH))
    ? parseJournal(readFileSync(join(dir, JOURNAL_RELATIVE_PATH), "utf-8"))
    : [];
  const generate = (extra: Record<string, unknown> = {}, onUpdate?: (u: unknown) => void) => tool.execute("call-1", {
    channel: CHANNEL, series: SERIES, episode: EPISODE, shotId: "shot-1",
    imagePath: "assets/images/look.png", audioPath: "artifacts/narration/line.wav", ...extra,
  }, undefined, onUpdate, {});
  const clip = (shotId = "shot-1") => join(dir, "assets", "video", `${shotId}.mp4`);

  it("builds its description and resolution choices from the profile", () => {
    expect(tool.description).toContain(avatarTerms());
    const schema = JSON.stringify(tool.parameters);
    for (const resolution of AVATAR_RESOLUTIONS) expect(schema).toContain(resolution);
  });

  it("uploads the photo and the audio, then submits their URLs", async () => {
    budget(100_000_000);
    const updates: unknown[] = [];
    const result = await generate({ seed: 11 }, (u) => updates.push(u));
    expect(uploads.map((u) => [u.name, u.type])).toEqual([["image.png", "image/png"], ["audio.wav", "audio/wav"]]);
    expect(uploads[1]!.bytes).toBe(readFileSync(join(fixtures, "line.wav")).length);
    expect(submitted).toEqual({
      image_url: "https://files.example/image.png",
      audio_url: "https://files.example/audio.wav",
      resolution: defaultResolution,
      enable_transcription: true, // the profile's default, applied by the contract
      seed: 11,
      enable_safety_checker: true,
    });
    expect(updates.length).toBeGreaterThan(0);
    expect(result.details).toMatchObject({ providerRequestId: "req-123", seed: 11, resolution: defaultResolution });
  });

  it("reads the photo from a channel source when imageSource names one", async () => {
    await generate({ imageSource: SOURCE, imagePath: "looks/studio.png" });
    expect(readFileSync(clip(), "utf-8")).toBe("mp4 bytes");
    const provenance = JSON.parse(readFileSync(join(dir, "assets", "video", "shot-1.provenance.json"), "utf-8"));
    expect(provenance).toMatchObject({ imageSource: SOURCE, imagePath: "looks/studio.png" });
    await expect(generate({ shotId: "b", imageSource: "no-such-source", imagePath: "looks/studio.png" })).rejects.toThrow(/no source/);
    await expect(generate({ shotId: "c", imageSource: SOURCE, imagePath: "../../../secret.png" })).rejects.toThrow();
  });

  it("places the clip and its provenance under assets/video", async () => {
    await generate({ seed: 3, enableTranscription: false });
    expect(readFileSync(clip(), "utf-8")).toBe("mp4 bytes");
    const provenance = JSON.parse(readFileSync(join(dir, "assets", "video", "shot-1.provenance.json"), "utf-8"));
    expect(provenance).toMatchObject({
      provider: "fal.ai",
      endpointId: minimaxH3MaxLipSync.endpointId,
      profileId: minimaxH3MaxLipSync.profileId,
      providerRequestId: "req-123",
      shotId: "shot-1",
      imagePath: "assets/images/look.png",
      imageSize: { width: 180, height: 320 },
      audioPath: "artifacts/narration/line.wav",
      resolution: defaultResolution,
      seed: 3,
      enableTranscription: false,
      estimatedCost: { amount: h3MaxLipSyncPriceUsd(defaultResolution, OK_SECONDS), currency: "USD" },
    });
    expect(provenance.audioDurationSeconds).toBeCloseTo(OK_SECONDS, 1);
    expect(provenance.imageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.audioSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(submitted).toMatchObject({ enable_transcription: false });
  });

  it("reserves price × the audio's length at the resolution asked, and settles it", async () => {
    budget(100_000_000);
    const resolution = AVATAR_RESOLUTIONS[0]!;
    await generate({ resolution });
    const events = journal();
    expect(events.map((e) => e.type)).toEqual(["spend-reserved", "spend-settled"]);
    const expected = toMicros(h3MaxLipSyncPriceUsd(resolution, OK_SECONDS));
    expect(events[0]!.data).toMatchObject({
      capability: "video.generate", provider: "fal", profile: minimaxH3MaxLipSync.profileId, purpose: "avatar shot-1",
    });
    const reserved = (events[0]!.data as { estimate: { micros: number } }).estimate.micros;
    // ffprobe's length is within a few ms of what ffmpeg was asked for.
    expect(Math.abs(reserved - expected)).toBeLessThan(expected * 0.01);
    expect(submitted).toMatchObject({ resolution });
  });

  it("reserves the long-video price for audio past the profile's threshold", async () => {
    budget(100_000_000);
    await generate({ audioPath: "artifacts/narration/long.wav" });
    const reserved = (journal()[0]!.data as { estimate: { micros: number } }).estimate.micros;
    const expected = toMicros(h3MaxLipSyncPriceUsd(defaultResolution, LONG_SECONDS));
    expect(Math.abs(reserved - expected)).toBeLessThan(expected * 0.01);
    expect(reserved).toBeGreaterThan(toMicros(pricesPerSecondUsd[defaultResolution] * LONG_SECONDS));
  });

  it("refuses audio shorter or longer than the profile allows, before any request", async () => {
    await expect(generate({ audioPath: "artifacts/narration/short.wav" })).rejects.toThrow(new RegExp(`at least ${audioSeconds.min} s`));
    await expect(generate({ audioPath: "artifacts/narration/endless.wav" })).rejects.toThrow(new RegExp(`at most ${audioSeconds.max} s`));
    await expect(generate({ imagePath: "assets/images/banner.png" })).rejects.toThrow(/crop it first/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(journal()).toEqual([]);
  });

  it("refuses over budget without calling fal or writing anything", async () => {
    budget(toMicros(h3MaxLipSyncPriceUsd(defaultResolution, OK_SECONDS)) - 10_000);
    await expect(generate()).rejects.toThrow(/budget/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(journal()).toEqual([]);
    expect(existsSync(clip())).toBe(false);
  });

  it("releases the reservation when an upload fails or fal refuses the request", async () => {
    budget(100_000_000);
    fetchMock.mockImplementationOnce(async () => Response.json({ detail: "no storage" }, { status: 403 }));
    await expect(generate()).rejects.toThrow();
    expect(journal().map((e) => e.type)).toEqual(["spend-reserved", "spend-released"]);
    expect(submitted).toBeUndefined();

    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) =>
      url === QUEUE && init?.method === "POST" ? Response.json({ detail: "bad audio" }, { status: 422 }) : real(url, init));
    await expect(generate()).rejects.toThrow();
    expect(journal().map((e) => e.type)).toEqual(["spend-reserved", "spend-released", "spend-reserved", "spend-released"]);
  });

  it("refuses before spending: a taken shotId, paths outside the episode, a wrong file type, no FAL_KEY", async () => {
    mkdirSync(join(dir, "assets", "video"), { recursive: true });
    writeFileSync(clip(), "old");
    await expect(generate()).rejects.toThrow(/already exists/);
    await expect(generate({ shotId: "x", imagePath: "../../../../secret.png" })).rejects.toThrow();
    await expect(generate({ shotId: "x", audioPath: "../../../../secret.wav" })).rejects.toThrow();
    await expect(generate({ shotId: "x", audioPath: "assets/images/look.png" })).rejects.toThrow(/Unsupported audio type/);
    await expect(generate({ shotId: "bad name" })).rejects.toThrow(/shotId/);
    delete process.env.FAL_KEY;
    await expect(generate({ shotId: "y" })).rejects.toThrow(/FAL_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readFileSync(clip(), "utf-8")).toBe("old");
  });

  it("replaces a clip only when told to", async () => {
    mkdirSync(join(dir, "assets", "video"), { recursive: true });
    writeFileSync(clip(), "old");
    process.env.FAL_KEY = "fal-key-for-tests";
    await generate({ overwrite: true });
    expect(readFileSync(clip(), "utf-8")).toBe("mp4 bytes");
  });
});
