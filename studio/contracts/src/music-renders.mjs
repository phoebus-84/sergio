// An audio file rendered from music written as code (ADR-0053):
// <output>.music.json beside it, naming the piece and the file by hash, what
// was asked and what was measured.

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schemas/v1alpha1/music-render.schema.json" with { type: "json" };

/** A piece of music: a file of Strudel code. */
export const MUSIC_EXTENSION = ".strudel";
/** Where a workspace keeps its pieces. */
export const MUSIC_DIR = "music";
export const MUSIC_RENDER_SUFFIX = ".music.json";

const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema(schema);

/** Problems of an <output>.music.json, as `{code, path, message}`; none when it is a MusicRender. */
export function validateMusicRender(doc) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/MusicRender`);
  if (validate(doc)) return [];
  return validate.errors.map((e) => ({ code: "schema", path: `$${e.instancePath.replace(/\//g, ".")}`, message: e.message }));
}
