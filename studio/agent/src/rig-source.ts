// ---------------------------------------------------------------------------
// The character a shot films: a rig of the episode, or a role of the cast
// ---------------------------------------------------------------------------
// A shot names its character one of two ways. `rigPath` is a rig still in
// the episode that made it, with its clips beside it: a test shot, before a
// release. `role` is a role of the series' cast: the release the role pins
// is read back against its record and used as it was released, standing as
// pva_release_model left it.
// ---------------------------------------------------------------------------

import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { episodePath } from "@studio/contracts/src/layout.mjs";
import { resolveCast, verifyRelease } from "@studio/cast";
import { readReleasedForm } from "./release-tools.js";
import { guardEpisodePath } from "./trust-guards.js";

export const CLIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface RigSource {
  /** The body's file. */
  rigFull: string;
  /** How it is named in what is said and kept: episode-relative, or library-relative for a released one. */
  rigShown: string;
  /** One of its clips by name: the file, and how it is named. Throws when it has none of that name. */
  clip(name: string): { full: string; shown: string };
  /** Who plays, when the character is a role. */
  cast: { role: string; character: string; form: string; release: string; treeSha256: string } | null;
  /** Released by pva_release_model: it faces +z and stands on y 0. */
  stood: boolean;
  /** rig-3d, model-3d: the medium of a role's form. Unknown for a rig of the episode. */
  medium: string | null;
}

export interface RigAsked {
  role?: string;
  rigPath?: string;
}

/**
 * The files of the character a shot asks for. `statue: true` lets a role
 * wear a model with no skeleton: it can stand in a picture, and plays no clip.
 */
export async function resolveRig(
  libraryRoot: string,
  ref: { channel: string; series: string; episode: string },
  asked: RigAsked,
  options: { statue?: boolean } = {},
): Promise<RigSource> {
  if ((asked.rigPath === undefined) === (asked.role === undefined)) {
    throw new Error("say which character is filmed: a rig of the episode (rigPath) or a role of the series' cast (role), one or the other");
  }
  const dir = episodePath(libraryRoot, ref.channel, ref.series, ref.episode);
  const guard = await guardEpisodePath(libraryRoot, ref.channel, ref.series, ref.episode, asked.rigPath ?? "assets");
  if (!guard.allowed) throw new Error(guard.reason ?? `Rig path rejected: ${asked.rigPath}`);

  if (asked.role !== undefined) {
    const role = resolveCast(libraryRoot, { channel: ref.channel, series: ref.series }).find((entry) => entry.role.role === asked.role);
    if (!role) throw new Error(`${ref.channel}/${ref.series} has no role "${asked.role}" in its cast: give the role to a character with pva_cast`);
    if (!role.release || !role.form || !role.dir || (role.state !== "ready" && role.state !== "behind")) throw new Error(`the role "${asked.role}" cannot be filmed: ${role.reason}`);
    const medium = role.form.medium;
    if (medium !== "rig-3d" && !(options.statue && medium === "model-3d")) {
      throw new Error(`the role "${asked.role}" wears the form "${role.form.id}", which is ${medium}: only a rig (rig-3d) is filmed playing a clip`);
    }
    const checked = verifyRelease(role.dir, role.release);
    if (checked.state !== "as-released") {
      throw new Error(`the files of "${role.form.id}" ${role.release.id} ${checked.state === "missing" ? "are not there" : "are not what was released"}: the role "${asked.role}" is not filmed from them`);
    }
    const folder = join(role.dir, ...role.release.path.split("/"));
    const record = readReleasedForm(folder);
    const entry = record?.entry ?? role.release.entry;
    if (!entry || !/\.glb$/i.test(entry)) throw new Error(`the release "${role.release.id}" of "${role.form.id}" names no .glb to open: release the rig with pva_release_model`);
    const shown = (full: string) => relative(libraryRoot, full);
    return {
      rigFull: join(folder, ...entry.split("/")),
      rigShown: shown(join(folder, ...entry.split("/"))),
      clip(name) {
        const has = record?.clips.map((clip) => clip.name) ?? [];
        const full = join(folder, ...(record?.clips.find((clip) => clip.name === name)?.file ?? `clips/${name}.glb`).split("/"));
        if (!existsSync(full)) {
          throw new Error(`the role "${asked.role}" has no action named ${name}` + (has.length ? `: its form can ${has.join(", ")}` : ": its form has no clip. Release the rig again with the clip played on its sheet"));
        }
        return { full, shown: shown(full) };
      },
      cast: { role: asked.role, character: role.role.character, form: role.form.id, release: role.release.id, treeSha256: role.release.tree.sha256 },
      stood: record !== null,
      medium,
    };
  }

  const rigFull = join(dir, asked.rigPath!);
  if (!existsSync(rigFull) || !statSync(rigFull).isFile()) throw new Error(`Rig not found: ${asked.rigPath}`);
  if (!/\.glb$/i.test(rigFull)) throw new Error(`Rig must be a binary glTF (.glb): ${asked.rigPath}`);
  return {
    rigFull,
    rigShown: asked.rigPath!,
    clip(name) {
      const full = join(dirname(rigFull), `${basename(rigFull).replace(/\.glb$/i, "")}.clip.${name}.glb`);
      if (!existsSync(full)) throw new Error(`the rig has no clip named ${name}: ${relative(dir, full)} is not there`);
      return { full, shown: relative(dir, full) };
    },
    cast: null,
    stood: false,
    medium: null,
  };
}
