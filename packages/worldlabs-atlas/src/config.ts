// ---------------------------------------------------------------------------
// Configuration, from the environment only (secrets never live in files)
// ---------------------------------------------------------------------------

import { AtlasUnavailableError } from "./errors.js";
import type { AtlasConfig } from "./types.js";

/**
 * The project API key. The name the provider's documentation uses could not
 * be read when this was written (docs/notes/worldlabs-atlas-api.md); this one
 * is ours.
 */
export const API_KEY_ENV = "WORLDLABS_API_KEY";
export const BASE_URL_ENV = "WORLDLABS_ATLAS_BASE_URL";
/** The host of the documented health check. */
export const DEFAULT_BASE_URL = "https://api.atlas.worldlabs.ai";
const DEFAULT_MAX_RETRIES = 4;

/** The configuration, or the reason there is none: a missing key is a state, not an exception. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): AtlasConfig | AtlasUnavailableError {
  const apiKey = env[API_KEY_ENV]?.trim();
  if (!apiKey) return new AtlasUnavailableError(`${API_KEY_ENV} is not set`);
  const baseUrl = (env[BASE_URL_ENV]?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/i.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl)) {
    return new AtlasUnavailableError(`${BASE_URL_ENV} must be an https origin with no path (the client adds /api/v2), not ${baseUrl}`);
  }
  const retries = Number.parseInt(env["WORLDLABS_ATLAS_MAX_RETRIES"] ?? "", 10);
  return { apiKey, baseUrl, maxRetries: Number.isInteger(retries) && retries >= 0 ? retries : DEFAULT_MAX_RETRIES };
}

export function requireConfig(env: NodeJS.ProcessEnv = process.env): AtlasConfig {
  const config = resolveConfig(env);
  if (config instanceof AtlasUnavailableError) throw config;
  return config;
}

/** A key as it may be shown: never more than its last four characters. */
export function redactKey(key: string): string {
  return key.length <= 8 ? "****" : `…${key.slice(-4)}`;
}
