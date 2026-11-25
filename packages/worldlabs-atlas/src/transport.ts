// ---------------------------------------------------------------------------
// HTTP by fetch
// ---------------------------------------------------------------------------

import { AtlasCancelledError, AtlasError, AtlasNetworkError } from "./errors.js";
import type { FetchBytes, HttpRequest, HttpResponse, Transport } from "./types.js";

const aborted = (err: unknown, signal?: AbortSignal) => signal?.aborted || (err instanceof Error && err.name === "AbortError");

export class FetchTransport implements Transport {
  async request(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    let response: Response;
    try {
      // A redirect is not followed: it would carry the key to another host.
      response = await fetch(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}), ...(signal ? { signal } : {}), redirect: "manual" });
    } catch (err) {
      if (aborted(err, signal)) throw new AtlasCancelledError("cancelled during a request");
      throw new AtlasNetworkError(err instanceof Error ? err.message : String(err));
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    return { status: response.status, headers, body: await response.text() };
  }
}

/** The bytes behind a read URL. The URL is its own authorization: no key is sent with it. */
export const fetchBytes: FetchBytes = async (url, signal) => {
  let response: Response;
  try {
    response = await fetch(url, { ...(signal ? { signal } : {}), redirect: "follow" });
  } catch (err) {
    if (aborted(err, signal)) throw new AtlasCancelledError("cancelled during a download");
    throw new AtlasNetworkError(err instanceof Error ? err.message : String(err));
  }
  if (!response.ok) throw new AtlasError(`Download failed with HTTP ${response.status}`, "ATLAS_DOWNLOAD", response.status >= 500, { status: response.status });
  return new Uint8Array(await response.arrayBuffer());
};
