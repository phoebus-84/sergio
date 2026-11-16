// ---------------------------------------------------------------------------
// Characters and casts (ADR-0052)
// ---------------------------------------------------------------------------
// A character is a record apart from how it appears: who it is, what it
// sounds like, and the forms it takes. A form is one way it appears — a rig,
// a sheet of sprites, a drawing made by code, a photograph, a dot, a sound —
// released in folders that are never edited, each recorded with its hash.
// A production's cast gives each role a character, the form it wears there
// and the release it is pinned to.
//
//   characters/<id>/character.yaml   the character, in whatever owns it
//   <series or film>/cast.yaml       who plays what in this production
//
// This module is the manifests' contract and reads no file: it is imported
// by the browser as well as by the tools that write them.
// ---------------------------------------------------------------------------

import schema from "../schemas/v1alpha1/character.schema.json" with { type: "json" };
import { check } from "./schema-lite.mjs";

export const CHARACTER_API_VERSION = "studio.video/v1alpha1";

/** The folder of an owner (a channel, a series, a film) that holds its characters. */
export const CHARACTERS_DIR = "characters";
/** A character's manifest, in its folder. */
export const CHARACTER_MANIFEST = "character.yaml";
/** A production's cast, in the series' or the film's folder. */
export const CAST_MANIFEST = "cast.yaml";
/** Where a new release of a form is put: forms/<form>/<release>/. One recorded where it already was stays there. */
export const FORMS_DIR = "forms";

const enumOf = (def, property) => Object.freeze([...schema.$defs[def].properties[property].enum]);

export const FORM_MEDIA = enumOf("Form", "medium");
export const CHARACTER_STATUSES = enumOf("Character", "status");
export const ROLE_STANDINGS = enumOf("Role", "standing");

/** What each medium is, for a person choosing one and for the agent making it. */
export const FORM_MEDIUM_DESCRIPTIONS = Object.freeze({
  "rig-3d": "A 3D model with a skeleton: it can be posed and animated (glTF, a .blend)",
  "model-3d": "A 3D model with no skeleton: it can be placed, turned and lit",
  "puppet-2d": "A flat figure cut into parts and rigged: a cut-out puppet",
  sprites: "Drawn poses on a sheet, played in order as actions",
  vector: "A drawing made by code: a component with poses, expressions and palettes",
  images: "Reference pictures an image or video model keeps the character consistent from",
  photo: "A photograph, still or made to speak",
  graphic: "A shape on screen and how it behaves: a dot, a line, a cursor",
  sound: "A sound that is the character: a motif, a noise, a rhythm",
  voice: "A voice and nothing to look at",
  other: "Something else; say what in mediumNote",
});

const validate = (def, what, doc) => {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return [{ code: "type", path: "$", message: `a ${what} manifest must be a mapping` }];
  }
  return check(schema, schema.$defs[def], doc);
};

/** Names used twice in a list, as problems at each repeat. */
function repeats(items, key, path, what) {
  const out = [];
  const seen = new Set();
  items.forEach((item, index) => {
    const id = item?.[key];
    if (typeof id !== "string") return;
    if (seen.has(id)) out.push({ code: "duplicate", path: `${path}[${index}].${key}`, message: `${what} "${id}" is there twice` });
    seen.add(id);
  });
  return out;
}

/**
 * Problems of a character manifest, as `{code, path, message}`; none when it
 * holds. Beyond its shape: a form or a release named twice, a current release
 * or a default form that is not there, and a medium of `other` that does not
 * say what it is.
 */
export function validateCharacter(doc) {
  const problems = validate("Character", "character", doc);
  if (problems.length > 0) return problems;
  const forms = doc.forms ?? [];
  problems.push(...repeats(forms, "id", "$.forms", "the form"));
  if (doc.defaultForm !== undefined && !forms.some((form) => form.id === doc.defaultForm)) {
    problems.push({ code: "unknown-form", path: "$.defaultForm", message: `there is no form "${doc.defaultForm}"` });
  }
  forms.forEach((form, f) => {
    const at = `$.forms[${f}]`;
    const releases = form.releases ?? [];
    problems.push(...repeats(releases, "id", `${at}.releases`, "the release"));
    if (form.medium === "other" && !form.mediumNote?.trim()) {
      problems.push({ code: "medium-note", path: `${at}.mediumNote`, message: "a form whose medium is other says what it is" });
    }
    if (form.current !== undefined && !releases.some((release) => release.id === form.current)) {
      problems.push({ code: "unknown-release", path: `${at}.current`, message: `the form "${form.id}" has no release "${form.current}"` });
    }
    releases.forEach((release, r) => {
      if (release.entrySha256 !== undefined && release.entry === undefined) {
        problems.push({ code: "entry", path: `${at}.releases[${r}].entrySha256`, message: "a hash of the entry file with no entry file named" });
      }
    });
  });
  return problems;
}

/** Problems of a cast manifest. Beyond its shape: a role named twice, a release pinned with no form. */
export function validateCast(doc) {
  const problems = validate("Cast", "cast", doc);
  if (problems.length > 0) return problems;
  problems.push(...repeats(doc.roles, "role", "$.roles", "the role"));
  doc.roles.forEach((role, index) => {
    if (role.treeSha256 !== undefined && role.release === undefined) {
      problems.push({ code: "pin", path: `$.roles[${index}].treeSha256`, message: "a pinned tree with no release named" });
    }
  });
  return problems;
}

/** The form a character wears when a production names none: its default, or its only one. */
export function defaultFormOf(character) {
  const forms = character.forms ?? [];
  if (character.defaultForm) return forms.find((form) => form.id === character.defaultForm) ?? null;
  return forms.length === 1 ? forms[0] : null;
}

/** A form's current release: the one it names, or its only one. */
export function currentReleaseOf(form) {
  const releases = form.releases ?? [];
  if (form.current) return releases.find((release) => release.id === form.current) ?? null;
  return releases.length === 1 ? releases[0] : null;
}

/** A role's `character` taken apart: `id`, or another owner's as `owner/id` (one or two segments of owner). */
export function parseCharacterRef(ref) {
  const parts = String(ref).split("/");
  return { owner: parts.length > 1 ? parts.slice(0, -1) : null, id: parts[parts.length - 1] };
}

/**
 * What of a form's `can` a request is missing: the names asked for that the
 * form does not have, by kind. Empty lists when it can do all of it.
 */
export function cannot(form, asked) {
  const missing = {};
  for (const kind of ["actions", "expressions", "mouths", "views"]) {
    const has = new Set(form.can?.[kind] ?? []);
    missing[kind] = (asked[kind] ?? []).filter((name) => !has.has(name));
  }
  return missing;
}
