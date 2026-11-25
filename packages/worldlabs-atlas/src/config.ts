// ---------------------------------------------------------------------------
// Configuration, from the environment only (secrets never live in files)
// ---------------------------------------------------------------------------
// The names are the provider's own: its documentation, its CLI and its
// TypeScript client read the same two variables.
// ---------------------------------------------------------------------------

import { AtlasUnavailableError } from "./errors.js";
import type { AtlasConfig } from "./types.js";

/** A project-scoped API key, sent as WLT-Api-Key. */
export const API_KEY_ENV = "WLT_API_KEY";
/** The API root, version included. */
export const BASE_URL_ENV = "WLT_API_BASE_URL";
export const DEFAULT_BASE_URL = "https://api.atlas.worldlabs.ai/api/v2";
/** What a key must be allowed for the tasks here; `operations.cancel` only to stop a job. */
export const KEY_SCOPES = ["tasks.create", "operations.read", "assets.create", "assets.read"] as const;
const DEFAULT_MAX_RETRIES = 4;

/** The configuration, or the reason there is none: a missing key is a state, not an exception. */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): AtlasConfig | AtlasUnavailableError {
  const apiKey = env[API_KEY_ENV]?.trim();
  if (!apiKey) return new AtlasUnavailableError(`${API_KEY_ENV} is not set`);
  const baseUrl = (env[BASE_URL_ENV]?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  // The key goes to this address in a header: nothing but https, or this machine.
  if (!/^https:\/\/[^/?#]+(\/[^?#]*)?$/i.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^?#]*)?$/i.test(baseUrl)) {
    return new AtlasUnavailableError(`${BASE_URL_ENV} must be an https API root such as ${DEFAULT_BASE_URL}, not ${baseUrl}`);
  }
  return { apiKey, baseUrl, maxRetries: DEFAULT_MAX_RETRIES };
}

export function requireConfig(env: NodeJS.ProcessEnv = process.env): AtlasConfig {
  const config = resolveConfig(env);
  if (config instanceof AtlasUnavailableError) throw config;
  return config;
}

/** A key as it may be shown: never more than its last four characters, which is what the platform shows too. */
export function redactKey(key: string): string {
  return key.length <= 8 ? "****" : `…${key.slice(-4)}`;
}
