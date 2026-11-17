// ---------------------------------------------------------------------------
// Who owns a character, and which production casts it
// ---------------------------------------------------------------------------
// A character lives in the `characters/` folder of what owns it: a channel,
// one of its series, or a film (ADR-0052). A production — a series or a film —
// casts from its own owner first and then from the one above it; another
// owner's character is named by its path.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHARACTERS_DIR } from "@studio/contracts/src/character.mjs";
import { channelPath, seriesPath } from "@studio/contracts/src/layout.mjs";

export class CastError extends Error {
  constructor(message: string, readonly code: string, readonly problems: { code: string; path: string; message: string; severity?: "error" | "warning" }[] = []) {
    super(message);
    this.name = "CastError";
  }
}

/** A channel or a film by its slug, or a channel's series as [channel, series]. */
export type Owner = readonly [project: string] | readonly [channel: string, series: string];

/** A series of a channel, or a film: what a cast belongs to. */
export type Production = { channel: string; series: string } | { film: string };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertSlug(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 64 || !SLUG.test(value)) {
    throw new CastError(`${label} "${String(value)}" must be lowercase letters, digits and single hyphens, at most 64 characters`, "bad-slug");
  }
}

export function assertOwner(owner: readonly string[]): asserts owner is Owner {
  if (owner.length < 1 || owner.length > 2) throw new CastError("a character's owner is a channel, a film, or a channel and one of its series", "bad-owner");
  owner.forEach((part, index) => assertSlug(index === 0 ? "the owner" : "the series", part));
}

export const ownerLabel = (owner: Owner): string => owner.join("/");

/** The owner's folder in the library. Throws when there is none. */
export function ownerDir(root: string, owner: Owner): string {
  assertOwner(owner);
  const dir = owner.length === 2 ? seriesPath(root, owner[0], owner[1]) : channelPath(root, owner[0]);
  if (!existsSync(dir)) throw new CastError(`there is no ${owner.length === 2 ? "series" : "channel or film"} ${ownerLabel(owner)} in the library`, "no-owner");
  return dir;
}

export const charactersDir = (root: string, owner: Owner): string => join(ownerDir(root, owner), CHARACTERS_DIR);

export function characterDir(root: string, owner: Owner, id: string): string {
  assertSlug("the character's id", id);
  return join(charactersDir(root, owner), id);
}

export const productionLabel = (production: Production): string => ("film" in production ? production.film : `${production.channel}/${production.series}`);

/** The folder a production's cast is kept in: the series', or the film's. */
export function productionDir(root: string, production: Production): string {
  return ownerDir(root, productionOwner(production));
}

/** The production as an owner: where its own characters are. */
export const productionOwner = (production: Production): Owner => ("film" in production ? [production.film] : [production.channel, production.series]);

/** Where a production looks for a character it names by id alone: itself, then what is above it. */
export function castingOwners(production: Production): Owner[] {
  return "film" in production ? [[production.film]] : [[production.channel, production.series], [production.channel]];
}
