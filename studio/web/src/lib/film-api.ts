/**
 * Requests to the film routes. Like the gateway client's own, but a refusal
 * keeps the problems the gateway located — a cut that does not hold names the
 * clip, and the timeline points at it.
 */

import { getGatewayClient } from "./gateway.svelte.ts";

export class FilmApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly problems: { code: string; path: string; message: string; severity?: string }[] = [],
  ) {
    super(message);
    this.name = "FilmApiError";
  }
}

export async function filmApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const client = getGatewayClient();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (client.token) headers.Authorization = `Bearer ${client.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${client.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new FilmApiError(
      typeof body.message === "string" ? body.message : response.statusText,
      response.status,
      typeof body.error === "string" ? body.error : "unknown",
      Array.isArray(body.problems) ? (body.problems as FilmApiError["problems"]) : [],
    );
  }
  return body as T;
}

/** A path the gateway serves, as a URL the browser can load. */
export function gatewayUrl(path: string | null | undefined): string | null {
  return path ? `${getGatewayClient().baseUrl}${path}` : null;
}
