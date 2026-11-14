import { describe, it, expect } from "vitest";
import {
  getProfile,
  requireValidParameters,
  minimaxH3MaxLipSync,
  H3_MAX_LIP_SYNC,
  h3MaxLipSyncPriceUsd,
} from "../src/profiles.js";
import { FalClientImpl } from "../src/client.js";
import { VideoProfileContract } from "../src/contracts/v1.js";
import { FalAdapterError, FalHttpError, FalValidationError } from "../src/errors.js";
import type { HttpRequest, HttpResponse, Transport } from "../src/types.js";

/**
 * MiniMax H3 Max lip-sync: a photo and a voice in, a talking video out. It is
 * priced per second of the audio, and the audio is a file, which the client
 * has to upload rather than inline.
 */
describe("MiniMax H3 Max lip-sync", () => {
  describe("profile", () => {
    it("is registered, with the endpoint's schema and defaults", () => {
      expect(getProfile("minimax/h3-max/lip-sync/image-to-video@v1")).toBe(minimaxH3MaxLipSync);
      const params = requireValidParameters(minimaxH3MaxLipSync, { image_url: "https://x/i.png", audio_url: "https://x/a.wav" });
      expect(params).toEqual({
        image_url: "https://x/i.png",
        audio_url: "https://x/a.wav",
        resolution: H3_MAX_LIP_SYNC.defaultResolution,
        enable_transcription: true,
        enable_safety_checker: true,
      });
    });

    it("refuses what the endpoint does not take, before any request", () => {
      expect(() => requireValidParameters(minimaxH3MaxLipSync, { image_url: "i" })).toThrow(FalValidationError);
      expect(() => requireValidParameters(minimaxH3MaxLipSync, { image_url: "i", audio_url: "a", resolution: "4K" })).toThrow(FalValidationError);
      expect(() => requireValidParameters(minimaxH3MaxLipSync, { image_url: "i", audio_url: "a", prompt: "smile" })).toThrow(FalValidationError);
    });

    it("answers with one video", () => {
      const result = new VideoProfileContract(minimaxH3MaxLipSync).parseResponse(
        { idempotencyKey: "k", binding: { endpointId: minimaxH3MaxLipSync.endpointId, contractVersion: "v1", baseUrl: "" }, parameters: {}, timeoutMs: 1000 },
        { request_id: "r1", status: "COMPLETED", result: { video: { url: "https://cdn/v.mp4" }, seed: 3, duration: 6 } },
      );
      expect(result.outputs).toEqual([{ url: "https://cdn/v.mp4", contentType: "video/mp4", contentLength: null, sha256: null }]);
    });
  });

  describe("price", () => {
    it("is per second of video at the resolution's rate", () => {
      expect(h3MaxLipSyncPriceUsd("480P", 6)).toBeCloseTo(0.3, 6);
      expect(h3MaxLipSyncPriceUsd("768P", 10)).toBeCloseTo(0.8, 6);
      expect(h3MaxLipSyncPriceUsd("1080P", 15)).toBeCloseTo(2.4, 6);
      expect(h3MaxLipSyncPriceUsd("2K", 5)).toBeCloseTo(1.6, 6);
    });

    it("costs more per second once the video is long", () => {
      const { overSeconds, priceMultiplier } = H3_MAX_LIP_SYNC.longVideo;
      const rate = H3_MAX_LIP_SYNC.pricesPerSecondUsd["768P"];
      expect(h3MaxLipSyncPriceUsd("768P", overSeconds)).toBeCloseTo(rate * overSeconds, 6);
      expect(h3MaxLipSyncPriceUsd("768P", overSeconds + 5)).toBeCloseTo(rate * (overSeconds + 5) * priceMultiplier, 6);
      expect(h3MaxLipSyncPriceUsd("768P", 20)).toBeCloseTo(1.92, 6);
    });

    it("refuses a resolution or a duration it cannot price", () => {
      expect(() => h3MaxLipSyncPriceUsd("4K" as never, 6)).toThrow(FalValidationError);
      expect(() => h3MaxLipSyncPriceUsd("768P", 0)).toThrow(FalValidationError);
    });

    it("gives the profile the shortest video at the default resolution", () => {
      expect(minimaxH3MaxLipSync.pricing.estimatedUnitCost)
        .toBeCloseTo(h3MaxLipSyncPriceUsd(H3_MAX_LIP_SYNC.defaultResolution, H3_MAX_LIP_SYNC.audioSeconds.min), 6);
    });
  });
});

describe("FalClientImpl.uploadFile", () => {
  const KEY = "fal-key-never-print-me";
  const client = (respond: (req: HttpRequest) => HttpResponse) => {
    const requests: HttpRequest[] = [];
    const transport: Transport = { request: async (req) => { requests.push(req); return respond(req); } };
    const impl = new FalClientImpl({
      config: { falKey: KEY, baseUrl: "https://fal.test", defaultTimeoutMs: 1000, maxRetries: 0 },
      contracts: [],
      transport,
      storageUrl: "https://storage.test",
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });
    return { impl, requests };
  };
  const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });
  const file = { bytes: new Uint8Array([1, 2, 3]), fileName: "line.wav", contentType: "audio/wav" };

  it("asks fal for an upload URL, sends the bytes there, and returns the file's URL", async () => {
    const { impl, requests } = client((req) => req.method === "POST"
      ? ok({ upload_url: "https://bucket.test/put?sig=1", file_url: "https://cdn.test/line.wav" })
      : { status: 200, headers: {}, body: "" });
    expect(await impl.uploadFile(file)).toBe("https://cdn.test/line.wav");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "https://storage.test/storage/upload/initiate?storage_type=fal-cdn-v3",
      headers: { authorization: `Key ${KEY}` },
    });
    expect(JSON.parse(requests[0]!.body as string)).toEqual({ file_name: "line.wav", content_type: "audio/wav" });
    // The signed URL is the authorization: the key is not sent to the bucket.
    expect(requests[1]).toEqual({ method: "PUT", url: "https://bucket.test/put?sig=1", headers: { "content-type": "audio/wav" }, body: file.bytes });
  });

  it("fails with fal's status when the upload is refused, and sends no bytes", async () => {
    const { impl, requests } = client(() => ({ status: 401, headers: {}, body: "no" }));
    await expect(impl.uploadFile(file)).rejects.toBeInstanceOf(FalHttpError);
    expect(requests).toHaveLength(1);
  });

  it("fails when fal names no URL", async () => {
    const { impl } = client(() => ok({}));
    await expect(impl.uploadFile(file)).rejects.toBeInstanceOf(FalAdapterError);
  });

  it("does nothing once cancelled", async () => {
    const { impl, requests } = client(() => ok({}));
    const gone = new AbortController();
    gone.abort();
    await expect(impl.uploadFile(file, gone.signal)).rejects.toThrow(/cancelled/);
    expect(requests).toHaveLength(0);
  });
});
