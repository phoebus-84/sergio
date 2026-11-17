// ---------------------------------------------------------------------------
// A production's cast: who plays what, pinned to what it wears
// ---------------------------------------------------------------------------
// `cast.yaml` in a series or a film gives each role a character, the form it
// wears there, and the release it is pinned to. Casting pins the form's
// current release, with its tree; from then on the role keeps that release
// whatever the character gets later, and resolving the cast says of each role
// whether what it pins is still there and still what it was.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  CAST_MANIFEST, CHARACTER_API_VERSION, cannot, currentReleaseOf, defaultFormOf, parseCharacterRef, validateCast,
  type CastManifest, type CastRole, type CharacterForm, type CharacterManifest, type FormCan, type FormRelease, type RoleStanding,
} from "@studio/contracts/src/character.mjs";
import { readCharacter, serializeYaml, writeAtomically, type Problem } from "./characters.js";
import { verifyRelease } from "./forms.js";
import { CastError, assertSlug, castingOwners, ownerLabel, productionDir, productionLabel, type Owner, type Production } from "./owners.js";

export const castPath = (root: string, production: Production): string => join(productionDir(root, production), CAST_MANIFEST);

export interface StoredCast {
  cast: CastManifest | null;
  exists: boolean;
  problems: Problem[];
}

/** A production's cast as it is on disk. A production with no cast.yaml has an empty cast, not a broken one. */
export function readCast(root: string, production: Production): StoredCast {
  const file = castPath(root, production);
  if (!existsSync(file)) return { cast: null, exists: false, problems: [] };
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf-8"));
  } catch (error) {
    return { cast: null, exists: true, problems: [{ code: "yaml", path: "$", message: `${CAST_MANIFEST} is not YAML: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const problems = validateCast(doc);
  return { cast: problems.length === 0 ? (doc as CastManifest) : null, exists: true, problems };
}

function usableCast(root: string, production: Production): CastManifest {
  const stored = readCast(root, production);
  if (stored.exists && !stored.cast) {
    throw new CastError(`the cast of ${productionLabel(production)} cannot be read: ${stored.problems.map((p) => `${p.path} ${p.message}`).slice(0, 4).join("; ")}`, "invalid-cast", stored.problems);
  }
  return stored.cast ?? { apiVersion: CHARACTER_API_VERSION, kind: "Cast", roles: [] };
}

interface Found {
  owner: Owner;
  manifest: CharacterManifest;
  dir: string;
}

/** The character a role names: in the production's own owners, or where its path says. */
function find(root: string, production: Production, ref: string): Found | { missing: string } {
  const { owner, id } = parseCharacterRef(ref);
  const owners: Owner[] = owner ? [owner as unknown as Owner] : castingOwners(production);
  let broken: string | null = null;
  for (const candidate of owners) {
    let stored;
    try {
      stored = readCharacter(root, candidate, id);
    } catch (error) {
      if (error instanceof CastError && owner) return { missing: error.message };
      continue;
    }
    if (!stored.exists) continue;
    if (!stored.manifest || stored.problems.length > 0) {
      broken = `${ownerLabel(candidate)}/${id} cannot be read: ${stored.problems.map((p) => `${p.path} ${p.message}`).slice(0, 3).join("; ")}`;
      continue;
    }
    return { owner: candidate, manifest: stored.manifest, dir: stored.dir };
  }
  return { missing: broken ?? `there is no character "${id}" in ${owners.map(ownerLabel).join(" or ")}` };
}

export interface CastRoleInput {
  role: string;
  /** A character by id, or another owner's as owner/id. */
  character: string;
  /** The form it wears here. The character's default when left out. */
  form?: string;
  /** The release to pin. The form's current one when left out. */
  release?: string;
  name?: string;
  standing?: RoleStanding;
  voice?: string;
  note?: string;
}

/**
 * Give a role to a character, or change who holds it. The form's release is
 * pinned with its tree as recorded, so the production keeps what it was cast
 * with. A form with nothing released is cast unpinned, and resolving says so.
 *
 * What belongs to the part — its name on screen, its standing, its voice, its
 * note — stays when the role is cast again, unless given anew: casting again
 * is how a role takes a newer release, and that must not cost it its standing.
 */
export function castRole(root: string, production: Production, input: CastRoleInput): { cast: CastManifest; role: CastRole } {
  assertSlug("the role", input.role);
  const cast = structuredClone(usableCast(root, production));
  const found = find(root, production, input.character);
  if ("missing" in found) throw new CastError(`the role "${input.role}" was not cast: ${found.missing}`, "no-character");

  let form: CharacterForm | null;
  if (input.form) {
    form = found.manifest.forms?.find((entry) => entry.id === input.form) ?? null;
    if (!form) throw new CastError(`${found.manifest.name} has no form "${input.form}" (it has: ${(found.manifest.forms ?? []).map((f) => f.id).join(", ") || "none"})`, "no-form");
  } else {
    form = defaultFormOf(found.manifest);
    if (!form && (found.manifest.forms?.length ?? 0) > 1) {
      throw new CastError(`${found.manifest.name} has several forms and no default: say which this role wears (${found.manifest.forms!.map((f) => f.id).join(", ")})`, "form-needed");
    }
  }
  let release: FormRelease | null = null;
  if (form) {
    release = input.release ? form.releases?.find((entry) => entry.id === input.release) ?? null : currentReleaseOf(form);
    if (input.release && !release) throw new CastError(`the form "${form.id}" of ${found.manifest.name} has no release "${input.release}"`, "no-release");
  }

  const index = cast.roles.findIndex((entry) => entry.role === input.role);
  const before = index >= 0 ? cast.roles[index] : undefined;
  const name = input.name ?? before?.name, standing = input.standing ?? before?.standing;
  const voice = input.voice ?? before?.voice, note = input.note ?? before?.note;
  const role: CastRole = {
    role: input.role,
    ...(name ? { name } : {}),
    character: input.character,
    ...(form ? { form: form.id } : {}),
    ...(release ? { release: release.id, treeSha256: release.tree.sha256 } : {}),
    ...(standing ? { standing } : {}),
    ...(voice ? { voice } : {}),
    ...(note ? { note } : {}),
  };
  if (index >= 0) cast.roles[index] = role;
  else cast.roles.push(role);
  const problems = validateCast(cast);
  if (problems.length > 0) throw new CastError(`the cast was not written: ${problems.map((p) => `${p.path} ${p.message}`).slice(0, 5).join("; ")}`, "invalid-cast", problems);
  writeAtomically(castPath(root, production), serializeYaml(cast));
  return { cast, role };
}

/** Take a role out of a production's cast. */
export function uncastRole(root: string, production: Production, role: string): CastManifest {
  const cast = structuredClone(usableCast(root, production));
  const index = cast.roles.findIndex((entry) => entry.role === role);
  if (index < 0) throw new CastError(`${productionLabel(production)} has no role "${role}"`, "no-role");
  cast.roles.splice(index, 1);
  writeAtomically(castPath(root, production), serializeYaml(cast));
  return cast;
}

export type RoleState =
  /** What the role pins is on record and is what it was. */
  | "ready"
  /** As ready, and the character has a newer release than the one pinned. */
  | "behind"
  /** The character has no form, or the form has nothing released: there is nothing to pin. */
  | "on-paper"
  /** A form with releases and no release pinned. */
  | "unpinned"
  /** The character, the form or the pinned release is not there, or is not what was pinned. */
  | "broken";

export interface ResolvedRole {
  role: CastRole;
  state: RoleState;
  /** One sentence a person or the agent can act on. */
  reason: string;
  owner: Owner | null;
  character: CharacterManifest | null;
  /** The character's folder: its documents and its releases are in it. */
  dir: string | null;
  form: CharacterForm | null;
  release: FormRelease | null;
  /** The voice the part speaks with: the role's, or the character's. */
  voice: string | null;
}

export interface ResolveOptions {
  /** Read every pinned file again and compare it with the record. Default false: the records are compared. */
  verify?: boolean;
}

/** Every role of a production with the character, the form and the release it resolves to. */
export function resolveCast(root: string, production: Production, options: ResolveOptions = {}): ResolvedRole[] {
  return usableCast(root, production).roles.map((role): ResolvedRole => {
    const none = { owner: null, character: null, dir: null, form: null, release: null, voice: role.voice ?? null };
    const found = find(root, production, role.character);
    if ("missing" in found) return { role, state: "broken", reason: found.missing, ...none };
    const { owner, manifest, dir } = found;
    const base = { role, owner, character: manifest, dir, voice: role.voice ?? manifest.voice?.profile ?? null };

    const form = role.form ? manifest.forms?.find((entry) => entry.id === role.form) ?? null : defaultFormOf(manifest);
    if (role.form && !form) return { ...base, state: "broken", reason: `${manifest.name} no longer has the form "${role.form}"`, form: null, release: null };
    if (!form) {
      const many = (manifest.forms?.length ?? 0) > 1;
      return { ...base, state: many ? "unpinned" : "on-paper", reason: many ? `${manifest.name} has several forms: cast the role again and say which it wears` : `${manifest.name} has no form yet`, form: null, release: null };
    }
    const current = currentReleaseOf(form);
    if (!role.release) {
      return (form.releases?.length ?? 0) === 0
        ? { ...base, state: "on-paper", reason: `the form "${form.id}" of ${manifest.name} has nothing released yet`, form, release: null }
        : { ...base, state: "unpinned", reason: `the role pins no release of "${form.id}": cast it again to pin ${current?.id ?? "one"}`, form, release: null };
    }
    const release = form.releases?.find((entry) => entry.id === role.release) ?? null;
    if (!release) return { ...base, state: "broken", reason: `the release "${role.release}" of "${form.id}" is no longer on ${manifest.name}'s record`, form, release: null };
    if (role.treeSha256 && role.treeSha256 !== release.tree.sha256) {
      return { ...base, state: "broken", reason: `the release "${release.id}" of "${form.id}" is not the one this role was cast with: its record changed`, form, release };
    }
    if (options.verify) {
      const { state } = verifyRelease(dir, release);
      if (state !== "as-released") {
        return { ...base, state: "broken", reason: `the files of "${form.id}" ${release.id} ${state === "missing" ? "are not there" : "are not what was released"}`, form, release };
      }
    }
    if (current && current.id !== release.id) {
      return { ...base, state: "behind", reason: `pinned to ${release.id}; ${manifest.name} now has ${current.id}. Cast the role again to take it`, form, release };
    }
    return { ...base, state: "ready", reason: `${manifest.name} as "${form.id}" ${release.id}`, form, release };
  });
}

export interface Ask {
  role: string;
  actions?: string[];
  expressions?: string[];
  mouths?: string[];
  views?: string[];
}

/**
 * What a script asks of its cast that the cast cannot do: a role nobody
 * holds, an action or an expression the form it wears does not have.
 */
export function checkAsks(root: string, production: Production, asks: readonly Ask[]): Problem[] {
  const resolved = new Map(resolveCast(root, production).map((entry) => [entry.role.role, entry]));
  const problems: Problem[] = [];
  asks.forEach((ask, index) => {
    const at = `$[${index}]`;
    const entry = resolved.get(ask.role);
    if (!entry) {
      problems.push({ code: "no-role", path: `${at}.role`, message: `nobody is cast as "${ask.role}"`, severity: "error" });
      return;
    }
    if (entry.state === "broken") problems.push({ code: "role-broken", path: `${at}.role`, message: `"${ask.role}": ${entry.reason}`, severity: "error" });
    if (!entry.form) return;
    const missing = cannot(entry.form, ask);
    for (const kind of ["actions", "expressions", "mouths", "views"] as const satisfies readonly (keyof FormCan)[]) {
      for (const name of missing[kind]) {
        const has = entry.form.can?.[kind] ?? [];
        problems.push({
          code: `cannot-${kind}`, path: `${at}.${kind}`, severity: "error",
          message: `"${ask.role}" (${entry.character?.name ?? "?"}, form "${entry.form.id}") has no ${kind.slice(0, -1)} "${name}"${has.length ? `: it has ${has.join(", ")}` : `: the form lists no ${kind}`}`,
        });
      }
    }
  });
  return problems;
}
