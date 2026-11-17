// ---------------------------------------------------------------------------
// A character on disk: made, read, changed, checked
// ---------------------------------------------------------------------------
// `characters/<id>/character.yaml` and the three documents beside it. Making
// a character writes what is missing and overwrites nothing; changing one
// goes through the contract, so a manifest on disk is always one a production
// can read.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
  CHARACTER_API_VERSION, CHARACTER_MANIFEST, validateCharacter,
  type CharacterForm, type CharacterLikeness, type CharacterManifest, type CharacterStatus, type CharacterVoice, type FormCan, type FormMedium, type ManifestProblem,
} from "@studio/contracts/src/character.mjs";
import { CastError, characterDir, charactersDir, ownerLabel, assertSlug, type Owner } from "./owners.js";

export type Problem = ManifestProblem & { severity?: "error" | "warning" };

let temporaries = 0;

/** Write through a temporary file, so no reader ever sees half a document. */
export function writeAtomically(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${(temporaries += 1)}.tmp`;
  writeFileSync(temporary, content, "utf-8");
  renameSync(temporary, target);
}

export const serializeYaml = (doc: unknown): string => stringify(doc, { lineWidth: 0 });

export interface StoredCharacter {
  /** The manifest, when the file is there and is a mapping. */
  manifest: CharacterManifest | null;
  exists: boolean;
  dir: string;
  problems: Problem[];
}

/** A character as it is on disk, with what is wrong with it. Never throws for a bad file. */
export function readCharacter(root: string, owner: Owner, id: string): StoredCharacter {
  const dir = characterDir(root, owner, id);
  const file = join(dir, CHARACTER_MANIFEST);
  if (!existsSync(file)) return { manifest: null, exists: false, dir, problems: [] };
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf-8"));
  } catch (error) {
    return { manifest: null, exists: true, dir, problems: [{ code: "yaml", path: "$", message: `${CHARACTER_MANIFEST} is not YAML: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const problems: Problem[] = validateCharacter(doc);
  const usable = doc !== null && typeof doc === "object" && !Array.isArray(doc);
  if (usable && (doc as CharacterManifest).id !== id && typeof (doc as CharacterManifest).id === "string") {
    problems.push({ code: "id-mismatch", path: "$.id", message: `the folder is ${id} and the manifest says ${(doc as CharacterManifest).id}` });
  }
  return { manifest: usable ? (doc as CharacterManifest) : null, exists: true, dir, problems };
}

/** A character that must be there and readable, or a CastError that says why not. */
export function existingCharacter(root: string, owner: Owner, id: string): { manifest: CharacterManifest; dir: string } {
  const stored = readCharacter(root, owner, id);
  if (!stored.exists) throw new CastError(`${ownerLabel(owner)} has no character "${id}"`, "no-character");
  if (!stored.manifest || stored.problems.length > 0) {
    throw new CastError(`the character ${ownerLabel(owner)}/${id} cannot be read: ${stored.problems.map((p) => `${p.path} ${p.message}`).slice(0, 4).join("; ")}`, "invalid-character", stored.problems);
  }
  return { manifest: stored.manifest, dir: stored.dir };
}

export interface CharacterSummary {
  id: string;
  name: string | null;
  summary: string | null;
  nature: string | null;
  status: CharacterStatus | null;
  forms: { id: string; medium: FormMedium; current: string | null; releases: number }[];
  voice: string | null;
  /** True when the manifest cannot be used as it is. */
  broken: boolean;
}

/** The owner's characters, by id. A folder with no manifest is not one. */
export function listCharacters(root: string, owner: Owner): CharacterSummary[] {
  const dir = charactersDir(root, owner);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((id): CharacterSummary[] => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !statSync(join(dir, id)).isDirectory()) return [];
    const stored = readCharacter(root, owner, id);
    if (!stored.exists) return [];
    const m = stored.manifest;
    return [{
      id,
      name: typeof m?.name === "string" ? m.name : null,
      summary: m?.summary ?? null,
      nature: m?.nature ?? null,
      status: m?.status ?? null,
      forms: (Array.isArray(m?.forms) ? m!.forms! : []).map((form) => ({ id: form.id, medium: form.medium, current: form.current ?? null, releases: form.releases?.length ?? 0 })),
      voice: m?.voice?.profile ?? null,
      broken: !m || stored.problems.length > 0,
    }];
  });
}

export interface CreateCharacterInput {
  id: string;
  name: string;
  summary?: string;
  nature?: string;
  /** Who it is and what never changes about it. Written to character.md. */
  identity?: string;
  /** Where it comes from and what it wants. Written to backstory.md. */
  backstory?: string;
  /** How it moves, speaks and plays a scene. Written to performance.md. */
  performance?: string;
  voice?: CharacterVoice;
  likeness?: CharacterLikeness;
  tags?: string[];
}

export interface CreateResult {
  dir: string;
  manifest: CharacterManifest;
  createdFiles: string[];
  existingFiles: string[];
}

const DOCUMENTS = [
  ["identity", "character.md", "Who this is, what it looks and sounds like, and what never changes about it."],
  ["backstory", "backstory.md", "Where it comes from, what it wants, what it is afraid of."],
  ["performance", "performance.md", "How it moves, speaks and plays a scene. What it never does."],
] as const;

/** Make a character: its manifest and its three documents. What is already there is left as it is. */
export function createCharacter(root: string, owner: Owner, input: CreateCharacterInput): CreateResult {
  assertSlug("the character's id", input.id);
  const dir = characterDir(root, owner, input.id);
  const result: CreateResult = { dir, manifest: null as unknown as CharacterManifest, createdFiles: [], existingFiles: [] };
  mkdirSync(dir, { recursive: true });

  const write = (name: string, content: string): void => {
    try {
      writeFileSync(join(dir, name), content, { encoding: "utf-8", flag: "wx" });
      result.createdFiles.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      result.existingFiles.push(name);
    }
  };

  const manifest: CharacterManifest = {
    apiVersion: CHARACTER_API_VERSION,
    kind: "Character",
    id: input.id,
    name: input.name,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.nature ? { nature: input.nature } : {}),
    status: "draft",
    documents: { identity: "character.md", backstory: "backstory.md", performance: "performance.md" },
    ...(input.voice ? { voice: input.voice } : {}),
    ...(input.likeness ? { likeness: input.likeness } : {}),
    forms: [],
    ...(input.tags?.length ? { tags: input.tags } : {}),
    createdAt: new Date().toISOString(),
  };
  const problems = validateCharacter(manifest);
  if (problems.length > 0) throw new CastError(`the character was not made: ${problems.map((p) => `${p.path} ${p.message}`).slice(0, 5).join("; ")}`, "bad-input", problems);

  write(CHARACTER_MANIFEST, serializeYaml(manifest));
  for (const [key, name, prompt] of DOCUMENTS) {
    const text = input[key]?.trim();
    write(name, text ? `# ${input.name}\n\n${text}\n` : `# ${input.name}\n\n<!-- ${prompt} -->\n`);
  }
  result.manifest = existingCharacter(root, owner, input.id).manifest;
  return result;
}

type Patch<T> = { [K in keyof T]?: T[K] | null };

export interface CharacterPatch extends Patch<Pick<CharacterManifest, "name" | "summary" | "nature" | "status" | "voice" | "likeness" | "defaultForm" | "relations" | "tags">> {
  /** A form to add, or to change by its id. Its releases are not set here: see releaseForm. */
  form?: { id: string; medium?: FormMedium; mediumNote?: string | null; title?: string | null; description?: string | null; can?: FormCan | null; current?: string | null };
  /** A form to take away. Refused while it has a release: what was released stays on record. */
  removeForm?: string;
}

/** Change a character's manifest. The result is held to the contract, or nothing is written. */
export function updateCharacter(root: string, owner: Owner, id: string, patch: CharacterPatch): CharacterManifest {
  const { manifest, dir } = existingCharacter(root, owner, id);
  const next = structuredClone(manifest) as CharacterManifest & Record<string, unknown>;
  const { form, removeForm, ...fields } = patch;
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  const forms = (next.forms ??= []);
  if (form) {
    assertSlug("the form's id", form.id);
    const existing = forms.find((entry) => entry.id === form.id);
    if (!existing && !form.medium) throw new CastError(`the new form "${form.id}" needs its medium`, "bad-input");
    const target = (existing ?? { id: form.id, medium: form.medium! }) as CharacterForm & Record<string, unknown>;
    for (const [key, value] of Object.entries(form)) {
      if (key === "id") continue;
      if (value === null) delete target[key];
      else if (value !== undefined) target[key] = value;
    }
    if (!existing) forms.push(target);
  }
  if (removeForm) {
    const index = forms.findIndex((entry) => entry.id === removeForm);
    if (index < 0) throw new CastError(`${id} has no form "${removeForm}"`, "no-form");
    if ((forms[index]!.releases?.length ?? 0) > 0) throw new CastError(`the form "${removeForm}" of ${id} has releases: what was released stays on record`, "form-released");
    forms.splice(index, 1);
    if (next.defaultForm === removeForm) delete next.defaultForm;
  }
  const problems = validateCharacter(next);
  if (problems.length > 0) throw new CastError(`${id} was not changed: ${problems.map((p) => `${p.path} ${p.message}`).slice(0, 5).join("; ")}`, "invalid-character", problems);
  writeAtomically(join(dir, CHARACTER_MANIFEST), serializeYaml(next));
  return next;
}
