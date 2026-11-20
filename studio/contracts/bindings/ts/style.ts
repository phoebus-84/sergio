/**
 * TypeScript bindings generated from style.schema.json
 * Schema: https://schemas.studio.video/v1alpha1/style.schema.json
 * Auto-generated — do not edit directly.
 */

export type ResourceVersion = "studio.video/v1alpha1";

export type Slug = string;

export type ParamId = string;

export type EntryId = string;

export type Version = string;

export type Sha256 = string;

export type Text = string;

export type HexColor = string;

export type Level = "channel" | "series" | "film" | "scene";

export interface StyleScaffold {
  /** A film format id (hd-24, vertical-30, …) a new film takes when none is asked for. */
  filmFormat?: string;
  /** Where a shot's picture usually comes from in this style. */
  shotSource?: "footage" | "stock" | "generated" | "animation" | "graphics" | "screen" | "mixed";
  /** Skills worth loading before making anything in this style. */
  skills?: Slug[];
  /** How long a piece in this style usually runs. */
  durationSeconds?: {
    min: number;
    max: number;
  };
}

export interface StyleTemplate {
  apiVersion: ResourceVersion;
  kind: "StyleTemplate";
  id: Slug;
  version: Version;
  title: string;
  summary: Text;
  tags?: Slug[];
  /** The levels it may be applied to. Omitted: all four. */
  levels?: Level[];
  /** Its parameter files, in the order a person reads them: params/<id>.json each. */
  parameters: ParamId[];
  scaffold?: StyleScaffold;
  credits?: string;
}

export interface PaletteColor {
  id: EntryId;
  name: string;
  value: HexColor;
  /** What the colour is for: ground, key line, the one accent. */
  role?: string;
}

export interface PaletteParams {
  kind: "palette";
  title: string;
  description?: string;
  /** The fewest colours the style holds to. */
  min?: number;
  /** The most colours the style allows. */
  max?: number;
  colors: PaletteColor[];
}

export interface ParamField {
  id: EntryId;
  label: string;
  description?: string;
  /** What the value is, and so which control edits it: a text box, a slider, a menu, a switch, a colour picker, a font menu. */
  "type": "text" | "number" | "enum" | "boolean" | "color" | "font";
  value: string | number | boolean;
  /** For enum: the values it may take. For font: the families offered (others may still be typed). */
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** For text: a paragraph rather than a line. */
  multiline?: boolean;
}

export interface ValuesParams {
  kind: "values";
  title: string;
  description?: string;
  fields: ParamField[];
}

export type StyleParams = PaletteParams | ValuesParams;

export interface TemplatePin {
  id: Slug;
  version: Version;
  /** Where the template was found: shipped with the studio, the library's _styles/, or the channel's or film's own styles/. */
  origin: "builtin" | "library" | "project";
  /** The template's files as they were when it was applied. */
  hash: Sha256;
}

export interface StyleBinding {
  apiVersion: ResourceVersion;
  kind: "StyleBinding";
  template: TemplatePin;
  appliedAt: string;
  /** When the style was copied from the level above rather than from a template: that level, as <project>/<series>. */
  copiedFrom?: string;
  note?: string;
}
