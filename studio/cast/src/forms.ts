// ---------------------------------------------------------------------------
// A form's releases: recorded once, never edited
// ---------------------------------------------------------------------------
// A release is a folder in the character's own folder. Recording it hashes
// every file in it; from then on the record says whether the folder is still
// what was released. A change to a form is another release.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import {
  CHARACTER_MANIFEST, FORMS_DIR, currentReleaseOf, validateCharacter,
  type CharacterForm, type CharacterManifest, type FormLicence, type FormMaker, type FormRelease, type ReleaseTree,
} from "@studio/contracts/src/character.mjs";
import { existingCharacter, readCharacter, serializeYaml, writeAtomically, type Problem } from "./characters.js";
import { CastError, assertSlug, ownerLabel, type Owner } from "./owners.js";

/** Files a desktop leaves behind: not part of what was released. */
const IGNORED = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** sha256 of a file, read in pieces: a rig or a clip is too large to hold at once. */
export function fileSha256(file: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1 << 20);
  const descriptor = openSync(file, "r");
  try {
    for (let read = readSync(descriptor, buffer, 0, buffer.length, null); read > 0; read = readSync(descriptor, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

/**
 * A folder as one hash: every file's hash and path, in the order of the
 * paths. Two folders with the same files have the same tree whatever made
 * them and whenever.
 */
export function hashTree(dir: string): ReleaseTree {
  const files: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (IGNORED.has(entry.name)) continue;
      const path = join(folder, entry.name);
      // A link is followed: what a release shows is what it points at.
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) files.push(path);
    }
  };
  walk(dir);
  if (files.length === 0) throw new CastError(`${dir} holds no file: there is nothing to release`, "empty-release");
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    bytes += statSync(file).size;
    hash.update(`${fileSha256(file)}  ${relative(dir, file).split(sep).join(posix.sep)}\n`);
  }
  return { sha256: hash.digest("hex"), files: files.length, bytes };
}

export interface ReleaseFormInput {
  form: string;
  /** The release's id: v1, v003, 2026-11. */
  release: string;
  /** The folder to record, inside the character's folder. Default forms/<form>/<release>. */
  path?: string;
  /** The file to open, inside that folder. */
  entry?: string;
  madeWith?: FormMaker[];
  licence?: FormLicence;
  note?: string;
  /** Make it the form's current release. Default true. */
  current?: boolean;
}

/** Record a folder as a release of a form. Refused when that release is on record already. */
export function releaseForm(root: string, owner: Owner, id: string, input: ReleaseFormInput): { manifest: CharacterManifest; release: FormRelease } {
  const { manifest, dir } = existingCharacter(root, owner, id);
  assertSlug("the release's id", input.release);
  const next = structuredClone(manifest);
  const form = next.forms?.find((entry) => entry.id === input.form);
  if (!form) throw new CastError(`${id} has no form "${input.form}": add the form first`, "no-form");
  if (form.releases?.some((release) => release.id === input.release)) {
    throw new CastError(`the release "${input.release}" of ${id}'s form "${input.form}" is on record: a release is never edited. Record the change as another release`, "release-exists");
  }
  const path = (input.path ?? `${FORMS_DIR}/${input.form}/${input.release}`).replace(/\/+$/, "");
  const folder = join(dir, ...path.split("/"));
  if (path.split("/").includes("..") || path.startsWith("/")) throw new CastError(`a release is a folder inside the character's own: ${path} is not`, "bad-input");
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new CastError(`there is no folder ${path} in ${ownerLabel(owner)}/characters/${id}: put the form's files there first`, "no-release-folder");
  if (input.entry !== undefined && !existsSync(join(folder, ...input.entry.split("/")))) {
    throw new CastError(`the entry file ${input.entry} is not in ${path}`, "no-entry");
  }

  const release: FormRelease = {
    id: input.release,
    path,
    ...(input.entry ? { entry: input.entry, entrySha256: fileSha256(join(folder, ...input.entry.split("/"))) } : {}),
    tree: hashTree(folder),
    ...(input.madeWith?.length ? { madeWith: input.madeWith } : {}),
    ...(input.licence ? { licence: input.licence } : {}),
    ...(input.note ? { note: input.note } : {}),
    createdAt: new Date().toISOString(),
  };
  (form.releases ??= []).push(release);
  if (input.current !== false) form.current = release.id;

  const problems = validateCharacter(next);
  if (problems.length > 0) throw new CastError(`the release was not recorded: ${problems.map((p) => `${p.path} ${p.message}`).slice(0, 5).join("; ")}`, "invalid-character", problems);
  writeAtomically(join(dir, CHARACTER_MANIFEST), serializeYaml(next));
  return { manifest: next, release };
}

export type ReleaseState = "as-released" | "changed" | "missing";

/** Whether a release's folder is still what was recorded. Reads every file of it. */
export function verifyRelease(characterDirectory: string, release: FormRelease): { state: ReleaseState; tree: ReleaseTree | null } {
  const folder = join(characterDirectory, ...release.path.split("/"));
  if (!existsSync(folder)) return { state: "missing", tree: null };
  let tree: ReleaseTree;
  try {
    tree = hashTree(folder);
  } catch {
    return { state: "missing", tree: null };
  }
  return { state: tree.sha256 === release.tree.sha256 ? "as-released" : "changed", tree };
}

export interface CheckCharacterOptions {
  /** Read every released file again and compare it with the record. Default true. */
  verify?: boolean;
}

/**
 * Everything wrong with a character as it is on disk: its manifest, the
 * documents it names, its releases against their records, and what a
 * production would want to know before casting it.
 */
export function checkCharacter(root: string, owner: Owner, id: string, options: CheckCharacterOptions = {}): Problem[] {
  const stored = readCharacter(root, owner, id);
  if (!stored.exists) return [{ code: "no-character", path: "$", message: `${ownerLabel(owner)} has no character "${id}"`, severity: "error" }];
  const problems: Problem[] = stored.problems.map((problem) => ({ ...problem, severity: "error" as const }));
  const manifest = stored.manifest;
  if (!manifest || problems.length > 0) return problems;
  const warn = (code: string, path: string, message: string) => problems.push({ code, path, message, severity: "warning" });
  const fail = (code: string, path: string, message: string) => problems.push({ code, path, message, severity: "error" });

  for (const [key, file] of Object.entries(manifest.documents ?? {})) {
    if (!existsSync(join(stored.dir, ...file.split("/")))) fail("missing-document", `$.documents.${key}`, `${file} is not there`);
  }
  if (manifest.voice?.motif && !existsSync(join(stored.dir, ...manifest.voice.motif.split("/")))) fail("missing-file", "$.voice.motif", `${manifest.voice.motif} is not there`);
  if (manifest.likeness?.evidence && !existsSync(join(stored.dir, ...manifest.likeness.evidence.split("/")))) fail("missing-file", "$.likeness.evidence", `${manifest.likeness.evidence} is not there`);

  const forms = manifest.forms ?? [];
  if (forms.length === 0) warn("no-form", "$.forms", "it has no form yet: it exists on paper only");
  if (forms.length > 1 && !manifest.defaultForm) warn("no-default-form", "$.defaultForm", "it has several forms and no default: a production must name the one it wears");
  forms.forEach((form: CharacterForm, f) => {
    const at = `$.forms[${f}]`;
    const releases = form.releases ?? [];
    if (releases.length === 0) warn("no-release", `${at}.releases`, `the form "${form.id}" has nothing released: it cannot be pinned`);
    else if (!currentReleaseOf(form)) warn("no-current-release", `${at}.current`, `the form "${form.id}" has ${releases.length} releases and none is current`);
    if (form.medium === "photo" && !manifest.likeness) {
      warn("likeness-unstated", "$.likeness", `the form "${form.id}" is a photograph: if it shows a real person, say whose likeness it is and what permits it`);
    }
    if (!form.can || [form.can.actions, form.can.expressions, form.can.mouths, form.can.views].every((list) => !list?.length)) {
      warn("can-nothing", `${at}.can`, `the form "${form.id}" does not say what it can do: a script cannot be checked against it`);
    }
    releases.forEach((release, r) => {
      const where = `${at}.releases[${r}]`;
      if (options.verify === false) {
        if (!existsSync(join(stored.dir, ...release.path.split("/")))) fail("release-missing", where, `the release "${release.id}" of "${form.id}" is not in ${release.path}`);
        return;
      }
      const { state } = verifyRelease(stored.dir, release);
      if (state === "missing") fail("release-missing", where, `the release "${release.id}" of "${form.id}" is not in ${release.path}`);
      else if (state === "changed") fail("release-changed", where, `the release "${release.id}" of "${form.id}" is not what was recorded: its files changed. Put them back, or record what is there as another release`);
    });
  });
  return problems;
}
