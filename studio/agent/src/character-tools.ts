// ---------------------------------------------------------------------------
// Characters and casts (ADR-0052)
// ---------------------------------------------------------------------------
// A character is a record apart from how it appears: who it is, what it
// sounds like, the forms it takes. These tools make and change the record,
// record a form's release, and give the roles of a series or a film to
// characters. They make no picture, no rig and no motion: a form's files are
// made with the tools of its medium and then recorded here.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  CHARACTER_STATUSES, FORM_MEDIA, FORM_MEDIUM_DESCRIPTIONS, ROLE_STANDINGS, currentReleaseOf, type CharacterManifest,
} from "@studio/contracts/src/character.mjs";
import {
  CastError, castRole, checkAsks, checkCharacter, createCharacter, listCharacters, ownerLabel, productionLabel, readCharacter, releaseForm,
  resolveCast, uncastRole, updateCharacter, type Ask, type Owner, type Problem, type Production, type ResolvedRole,
} from "@studio/cast";
import { resolveConfig } from "./config.js";

const OWNER_PARAMS = {
  owner: Type.String({ description: "The channel or the film the character belongs to, by slug" }),
  series: Type.Optional(Type.String({ description: "A series of that channel, when the character belongs to the series and not to the whole channel" })),
};

const NAMES = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));

const CAN = Type.Object({
  actions: NAMES("What it can do, by the names a script asks for: idle, walk, wave"),
  expressions: NAMES("The expressions it has: neutral, puzzled, proud"),
  mouths: NAMES("The mouth shapes it has for speech"),
  views: NAMES("The sides it can be shown from: front, three-quarter, side"),
  note: Type.Optional(Type.String()),
}, { description: "What this form can do. A script is checked against it" });

type ToolResult = { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean };

const ok = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details });

function fail(error: unknown): ToolResult {
  const e = error as { message?: string; code?: string; problems?: Problem[] };
  const problems = (e.problems ?? []).slice(0, 30).map((p) => `  - ${p.code}${p.path ? ` at ${p.path}` : ""}: ${p.message}`);
  return {
    content: [{ type: "text", text: [`❌ ${e.code ? `${e.code}: ` : ""}${e.message ?? String(error)}`, ...problems].join("\n") }],
    details: { code: e.code ?? null, problems: e.problems ?? [] },
    isError: true as unknown as boolean,
  };
}

const ownerOf = (params: { owner: string; series?: string }): Owner => (params.series ? [params.owner, params.series] : [params.owner]);

function productionOf(params: { channel?: string; series?: string; film?: string }): Production {
  if (params.film && !params.channel && !params.series) return { film: params.film };
  if (params.channel && params.series && !params.film) return { channel: params.channel, series: params.series };
  throw new CastError("a cast belongs to a series (channel and series) or to a film (film): give one or the other", "bad-input");
}

const list = (label: string, names: readonly string[] | undefined): string => (names?.length ? `${label}: ${names.join(", ")}` : "");

function describeCharacter(owner: Owner, manifest: CharacterManifest, problems: Problem[]): string {
  const lines = [
    `${manifest.name} (${ownerLabel(owner)}/${manifest.id})${manifest.nature ? ` — ${manifest.nature}` : ""} · ${manifest.status ?? "draft"}`,
    ...(manifest.summary ? [`  ${manifest.summary}`] : []),
    `  voice: ${manifest.voice?.profile ?? (manifest.voice?.motif ? `a sound, ${manifest.voice.motif}` : "none set")}` +
      (manifest.likeness ? ` · likeness of ${manifest.likeness.of}: ${manifest.likeness.permission}` : ""),
    `  documents: ${Object.values(manifest.documents ?? {}).join(", ") || "none"} (in characters/${manifest.id}/: read them before writing for this character)`,
  ];
  const forms = manifest.forms ?? [];
  if (forms.length === 0) lines.push("  forms: none yet. It exists on paper");
  for (const form of forms) {
    const current = currentReleaseOf(form);
    lines.push(
      `  ▸ ${form.id}${form.id === manifest.defaultForm ? " (default)" : ""} — ${form.medium}${form.mediumNote ? `: ${form.mediumNote}` : ""}` +
        `${form.title ? ` · ${form.title}` : ""} · ${current ? `release ${current.id} in ${current.path}${current.entry ? `, open ${current.entry}` : ""}` : `${form.releases?.length ?? 0} release(s), none current`}`,
    );
    const can = [list("actions", form.can?.actions), list("expressions", form.can?.expressions), list("mouths", form.can?.mouths), list("views", form.can?.views)].filter(Boolean);
    if (can.length > 0) lines.push(`      ${can.join(" · ")}`);
  }
  for (const relation of manifest.relations ?? []) lines.push(`  ↔ ${relation.to}: ${relation.note}`);
  for (const problem of problems) lines.push(`  ${problem.severity === "warning" ? "⚠️" : "❌"} ${problem.code}: ${problem.message}`);
  return lines.join("\n");
}

const MARK: Record<ResolvedRole["state"], string> = { ready: "●", behind: "◐", "on-paper": "○", unpinned: "○", broken: "✗" };

function describeCast(production: Production, roles: ResolvedRole[]): string {
  if (roles.length === 0) return `${productionLabel(production)} has no cast yet: give a role to a character with pva_cast { role, character }`;
  const lines = [`Cast of ${productionLabel(production)}:`];
  for (const entry of roles) {
    const { role } = entry;
    lines.push(
      `${MARK[entry.state]} ${role.role}${role.name ? ` "${role.name}"` : ""} — ${entry.character?.name ?? role.character}` +
        `${entry.owner && role.character.includes("/") ? ` (of ${ownerLabel(entry.owner)})` : ""}${role.standing ? ` · ${role.standing}` : ""} · ${entry.state}: ${entry.reason}`,
    );
    const can = [list("actions", entry.form?.can?.actions), list("expressions", entry.form?.can?.expressions), list("mouths", entry.form?.can?.mouths), list("views", entry.form?.can?.views)].filter(Boolean);
    if (can.length > 0) lines.push(`    ${can.join(" · ")}`);
    if (entry.voice) lines.push(`    voice: ${entry.voice}`);
  }
  lines.push("", "● ready ◐ a newer release exists ○ nothing to pin yet ✗ broken");
  return lines.join("\n");
}

export function registerCharacterTools(pi: ExtensionAPI): void {
  const root = async (): Promise<string> => (await resolveConfig()).libraryRoot;

  pi.registerTool({
    name: "pva_characters",
    label: "Characters",
    description:
      "List the characters a channel, a series or a film owns, or with id show one in full: who it is, its voice, its forms, what each form can do, " +
      "its releases, and everything wrong with it on disk. A character is a record apart from how it appears (characters/<id>/character.yaml with " +
      "character.md, backstory.md and performance.md beside it): read those documents before writing for the character. Load the character-development skill.",
    parameters: Type.Object({
      ...OWNER_PARAMS,
      id: Type.Optional(Type.String({ description: "A character's id: show it in full. Omitted: list the owner's characters" })),
      verify: Type.Optional(Type.Boolean({ description: "With id: read every released file again and compare it with its record. Default true" })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        const owner = ownerOf(params);
        if (!params.id) {
          const all = listCharacters(library, owner);
          if (all.length === 0) return ok(`${ownerLabel(owner)} has no character yet: make one with pva_create_character`, { characters: [] });
          const lines = all.map((c) => `${c.broken ? "✗" : "●"} ${c.id} — ${c.name ?? "?"}${c.nature ? `, ${c.nature}` : ""}${c.summary ? `: ${c.summary}` : ""}` +
            ` · ${c.forms.length ? c.forms.map((f) => `${f.id} (${f.medium}${f.current ? `, ${f.current}` : ""})`).join(", ") : "on paper"}${c.voice ? ` · voice ${c.voice}` : ""}`);
          return ok([`Characters of ${ownerLabel(owner)}:`, ...lines].join("\n"), { characters: all });
        }
        const stored = readCharacter(library, owner, params.id);
        const problems = checkCharacter(library, owner, params.id, { verify: params.verify !== false });
        if (!stored.manifest) return { ...ok([`❌ ${ownerLabel(owner)}/${params.id}`, ...problems.map((p) => `  - ${p.code}: ${p.message}`)].join("\n"), { problems }), isError: true as unknown as boolean };
        return ok(describeCharacter(owner, stored.manifest, problems), { character: stored.manifest, dir: stored.dir, problems });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_create_character",
    label: "Create Character",
    description:
      "Make a character: who it is, before how it appears. Writes characters/<id>/ in the channel, the series or the film that owns it, with " +
      "character.yaml and three documents — character.md (identity: what never changes), backstory.md (where it comes from, what it wants), " +
      "performance.md (how it moves, speaks and plays a scene; what it never does). A character can be anything: a person, an animal, an object, " +
      "a dot, a sound. It has no form yet; add one with pva_update_character. Never overwrites. A character drawn from a real person's face, voice " +
      "or name needs likeness: whose, and what permits it. Load the character-development skill first.",
    parameters: Type.Object({
      ...OWNER_PARAMS,
      id: Type.String({ description: "Lowercase slug, stable: every script and cast names the character by it" }),
      name: Type.String({ description: "The character's name" }),
      summary: Type.Optional(Type.String({ description: "Who this is, in a sentence" })),
      nature: Type.Optional(Type.String({ description: "What kind of thing it is, in free words: a person, a fox, a lamp, a doubt, a sound" })),
      identity: Type.Optional(Type.String({ description: "character.md: who it is, what it looks and sounds like, what never changes" })),
      backstory: Type.Optional(Type.String({ description: "backstory.md: where it comes from, what it wants, what it fears" })),
      performance: Type.Optional(Type.String({ description: "performance.md: how it moves, speaks and plays a scene; what it never does" })),
      voiceProfile: Type.Optional(Type.String({ description: "A voice of the owner's voices registry, by its key (see pva_voices)" })),
      likeness: Type.Optional(Type.Object({
        of: Type.String({ description: "The real person it is drawn from" }),
        permission: Type.String({ description: "What allows it: who agreed, when, to what use" }),
        evidence: Type.Optional(Type.String({ description: "A file in the character's folder that shows it" })),
      })),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        const owner = ownerOf(params);
        const { owner: _owner, series: _series, voiceProfile, ...input } = params;
        const made = createCharacter(library, owner, { ...input, ...(voiceProfile ? { voice: { profile: voiceProfile } } : {}) });
        if (made.createdFiles.length === 0) {
          return ok(`${ownerLabel(owner)}/${params.id} was already there: nothing was changed. Change it with pva_update_character`, { character: made.manifest, dir: made.dir });
        }
        return ok(
          [`✅ ${made.manifest.name} (${ownerLabel(owner)}/${made.manifest.id}) — on paper: no form yet`,
            `   wrote ${made.createdFiles.join(", ")} in ${made.dir}`,
            ...(made.existingFiles.length ? [`   kept as they were: ${made.existingFiles.join(", ")}`] : []),
            "   next: write the three documents in full, then give it a form with pva_update_character { form }"].join("\n"),
          { character: made.manifest, dir: made.dir, createdFiles: made.createdFiles },
        );
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_update_character",
    label: "Update Character",
    description:
      "Change a character's record, give it a form, or record a release of a form. In fields, null removes one. " +
      `form { id, medium, … } adds a form or changes it; the media are ${FORM_MEDIA.map((m) => `${m} (${FORM_MEDIUM_DESCRIPTIONS[m]})`).join("; ")}. ` +
      "A form's `can` lists what it can do by the names a script asks for. " +
      "release { form, release, … } records a folder of the character as a release of that form, with the hash of every file in it: put the form's " +
      "files in characters/<id>/forms/<form>/<release>/ first (or name with path a folder already in the character's own). A release is never " +
      "edited: a change is another release. Roles already cast keep the release they pinned. Load the character-forms skill.",
    parameters: Type.Object({
      ...OWNER_PARAMS,
      id: Type.String({ description: "The character's id" }),
      name: Type.Optional(Type.String()),
      summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      nature: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      status: Type.Optional(StringEnum(CHARACTER_STATUSES, { description: "draft, ready (a production may cast it), retired" })),
      voiceProfile: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "A voice of the owner's voices registry, by its key" })),
      likeness: Type.Optional(Type.Union([Type.Object({ of: Type.String(), permission: Type.String(), evidence: Type.Optional(Type.String()) }), Type.Null()])),
      defaultForm: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "The form a production wears when it names none" })),
      relations: Type.Optional(Type.Array(Type.Object({ to: Type.String({ description: "Another character's id" }), note: Type.String() }))),
      tags: Type.Optional(Type.Array(Type.String())),
      form: Type.Optional(Type.Object({
        id: Type.String({ description: "The form's id: puppet, pixels, portrait, dot" }),
        medium: Type.Optional(StringEnum(FORM_MEDIA, { description: "Required for a new form" })),
        mediumNote: Type.Optional(Type.String({ description: "What the medium is, when it is other" })),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String({ description: "What this form is and when a production wears it" })),
        can: Type.Optional(CAN),
        current: Type.Optional(Type.String({ description: "Which of its releases a new casting takes" })),
      })),
      removeForm: Type.Optional(Type.String({ description: "A form to take away. Refused while it has a release" })),
      release: Type.Optional(Type.Object({
        form: Type.String({ description: "The form this is a release of" }),
        release: Type.String({ description: "The release's id: v1, v2, 2026-11" }),
        path: Type.Optional(Type.String({ description: "The folder to record, inside the character's own. Default forms/<form>/<release>" })),
        entry: Type.Optional(Type.String({ description: "The file to open, inside that folder: puppet.blend, manifest.json" })),
        madeWith: Type.Optional(Type.Array(Type.Object({
          tool: Type.String({ description: "What made it: a program, a model, a person's hand" }),
          provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()), note: Type.Optional(Type.String()),
        }))),
        licence: Type.Optional(Type.Object({
          id: Type.String({ description: "SPDX id where there is one: CC0-1.0, MIT, CC-BY-4.0" }),
          holder: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
          attribution: Type.Optional(Type.String({ description: "The credit it requires, as it must appear" })),
          redistributable: Type.Optional(Type.Boolean({ description: "Whether its files may be published with the channel" })),
        })),
        note: Type.Optional(Type.String()),
        current: Type.Optional(Type.Boolean({ description: "Make it the form's current release. Default true" })),
      })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        const owner = ownerOf(params);
        const { owner: _owner, series: _series, id, voiceProfile, release, ...patch } = params;
        const changed = Object.keys(patch).length > 0 || voiceProfile !== undefined;
        if (!changed && !release) throw new CastError("nothing to change: give a field, a form, or a release", "bad-input");
        let manifest: CharacterManifest | undefined;
        const done: string[] = [];
        if (changed) {
          manifest = updateCharacter(library, owner, id, {
            ...(patch as Parameters<typeof updateCharacter>[3]),
            ...(voiceProfile !== undefined ? { voice: voiceProfile === null ? null : { profile: voiceProfile } } : {}),
          });
          done.push(patch.form ? `form "${patch.form.id}" set` : patch.removeForm ? `form "${patch.removeForm}" removed` : "record changed");
        }
        if (release) {
          const recorded = releaseForm(library, owner, id, release);
          manifest = recorded.manifest;
          done.push(`release ${recorded.release.id} of "${release.form}" recorded: ${recorded.release.tree.files} file(s), ${(recorded.release.tree.bytes / 1024 / 1024).toFixed(1)} MB, tree ${recorded.release.tree.sha256.slice(0, 12)}…`);
        }
        const problems = checkCharacter(library, owner, id, { verify: false });
        return ok([`✅ ${ownerLabel(owner)}/${id}: ${done.join("; ")}`, describeCharacter(owner, manifest!, problems)].join("\n"), { character: manifest, problems });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_cast",
    label: "Cast",
    description:
      "A production's cast: who plays what in a series (channel and series) or a film. With nothing else, shows every role with the character, the " +
      "form it wears, the release it is pinned to, what that form can do, and whether what it pins is still there. With role and character, gives " +
      "the role to that character and pins its form's current release (cast it again to take a newer one: its name, standing, voice and note stay unless given anew); a series finds a character in itself and " +
      "then in its channel, and another owner's is named owner/id. With role and remove, takes the role away. With asks, checks what a script asks " +
      "of its roles — actions, expressions, mouths, views — against what their forms can do, before anything is animated. " +
      "The same character may hold different roles in different productions.",
    parameters: Type.Object({
      channel: Type.Optional(Type.String({ description: "The channel, with series" })),
      series: Type.Optional(Type.String({ description: "The series whose cast this is" })),
      film: Type.Optional(Type.String({ description: "The film whose cast this is, instead of channel and series" })),
      role: Type.Optional(Type.String({ description: "The part, as this production's scripts name it (a slug)" })),
      character: Type.Optional(Type.String({ description: "With role: the character that plays it, by id, or another owner's as owner/id" })),
      form: Type.Optional(Type.String({ description: "The form it wears here. The character's default when omitted" })),
      release: Type.Optional(Type.String({ description: "The release to pin. The form's current one when omitted" })),
      name: Type.Optional(Type.String({ description: "The part's name on screen, when it is not the character's" })),
      standing: Type.Optional(StringEnum(ROLE_STANDINGS)),
      voice: Type.Optional(Type.String({ description: "A voice profile for this part, when it is not the character's own" })),
      note: Type.Optional(Type.String()),
      remove: Type.Optional(Type.Boolean({ description: "With role: take the role out of the cast" })),
      asks: Type.Optional(Type.Array(Type.Object({
        role: Type.String(), actions: NAMES("Actions the script asks of this role"), expressions: NAMES("Expressions it asks for"),
        mouths: NAMES("Mouth shapes it asks for"), views: NAMES("Views it asks for"),
      }), { description: "What a script asks of its roles, to check against what their forms can do" })),
      verify: Type.Optional(Type.Boolean({ description: "Read every pinned file again and compare it with its record. Default false" })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        const production = productionOf(params);
        const lines: string[] = [];
        if (params.role && params.remove) {
          uncastRole(library, production, params.role);
          lines.push(`✅ "${params.role}" is no longer in the cast of ${productionLabel(production)}`);
        } else if (params.role) {
          if (!params.character) throw new CastError(`say who plays "${params.role}": character`, "bad-input");
          const { role: _role, character: _character, channel: _c, series: _s, film: _f, remove: _r, asks: _a, verify: _v, ...rest } = params;
          const { role } = castRole(library, production, { role: params.role, character: params.character, ...rest });
          lines.push(`✅ "${role.role}" is ${role.character}${role.form ? ` as "${role.form}"` : ""}${role.release ? `, pinned to ${role.release}` : ", with nothing to pin yet"}`);
        }
        const resolved = resolveCast(library, production, { verify: params.verify === true });
        lines.push(describeCast(production, resolved));
        const problems = params.asks ? checkAsks(library, production, params.asks as Ask[]) : [];
        if (params.asks) {
          lines.push("", problems.length === 0 ? "✅ the cast can do everything asked" : `❌ ${problems.length} thing(s) asked that the cast cannot do:`, ...problems.map((p) => `  - ${p.message}`));
        }
        const broken = resolved.some((entry) => entry.state === "broken") || problems.length > 0;
        return { ...ok(lines.join("\n"), { roles: resolved.map(({ dir: _dir, ...rest }) => rest), problems }), ...(broken ? { isError: true as unknown as boolean } : {}) };
      } catch (error) {
        return fail(error);
      }
    },
  });
}
