/**
 * TypeScript bindings generated from character.schema.json
 * Schema: https://schemas.studio.video/v1alpha1/character.schema.json
 * Auto-generated — do not edit directly.
 */

export type ResourceVersion = "studio.video/v1alpha1";

export type Slug = string;

export type RelativePath = string;

export type Sha256 = string;

export type Name = string;

export interface Documents {
  /** Who it is and what never changes about it. */
  identity?: RelativePath;
  /** Where it comes from; what it wants. */
  backstory?: RelativePath;
  /** How it moves, speaks and plays a scene; what it never does. */
  performance?: RelativePath;
}

export interface Voice {
  /** A voice of the owner's voices registry, by its key. */
  profile?: string;
  /** A sound that stands for the character, when it does not speak. */
  motif?: RelativePath;
  language?: string;
  note?: string;
}

export interface Likeness {
  of: string;
  /** What allows it: who agreed, when, to what use. */
  permission: string;
  evidence?: RelativePath;
}

export interface Can {
  actions?: Name[];
  expressions?: Name[];
  /** Mouth shapes it has, for speech. */
  mouths?: Name[];
  /** The sides it can be shown from. */
  views?: Name[];
  note?: string;
}

export interface Maker {
  /** What made it: a program, a model, a person's hand. */
  tool: string;
  provider?: string;
  model?: string;
  note?: string;
}

export interface Licence {
  /** SPDX id where there is one; else the licence's own name. */
  id: string;
  holder?: string;
  url?: string;
  /** The credit it requires, as it must appear. */
  attribution?: string;
  /** Whether the files may be published with the channel. */
  redistributable?: boolean;
}

export interface Tree {
  sha256: Sha256;
  files: number;
  bytes: number;
}

export interface Release {
  id: Slug;
  /** The release's folder. Never edited once recorded. */
  path: RelativePath;
  /** The file to open, inside the folder. */
  entry?: RelativePath;
  entrySha256?: Sha256;
  tree: Tree;
  madeWith?: Maker[];
  licence?: Licence;
  note?: string;
  createdAt?: string;
}

export interface Form {
  id: Slug;
  medium: "rig-3d" | "model-3d" | "puppet-2d" | "sprites" | "vector" | "images" | "photo" | "graphic" | "sound" | "voice" | "other";
  /** What the medium is, when it is other. */
  mediumNote?: string;
  title?: string;
  /** What this form is and when a production wears it. */
  description?: string;
  can?: Can;
  /** The release a new casting takes. */
  current?: Slug;
  releases?: Release[];
}

export interface Relation {
  to: string;
  note: string;
}

export interface Character {
  apiVersion: ResourceVersion;
  kind: "Character";
  id: Slug;
  name: string;
  /** Who this is, in a sentence. */
  summary?: string;
  /** What kind of thing it is, in free words: a person, a fox, a lamp, a doubt, a sound. */
  nature?: string;
  status?: "draft" | "ready" | "retired";
  documents?: Documents;
  voice?: Voice;
  likeness?: Likeness;
  forms?: Form[];
  defaultForm?: Slug;
  relations?: Relation[];
  tags?: string[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface Role {
  /** The part, as this production's scripts name it. */
  role: Slug;
  /** The part's name on screen, when it is not the character's. */
  name?: string;
  /** A character of this production's owner by id, or another's as owner/id (channel/id, film/id, channel/series/id). */
  character: string;
  /** The form it wears here. The character's default when left out. */
  form?: Slug;
  /** The release it is pinned to. */
  release?: Slug;
  /** The pinned release's tree, as it was when cast. */
  treeSha256?: Sha256;
  standing?: "lead" | "regular" | "guest" | "cameo" | "extra";
  /** A voice profile for this part, when it is not the character's own. */
  voice?: string;
  note?: string;
}

export interface Cast {
  apiVersion: ResourceVersion;
  kind: "Cast";
  roles: Role[];
  note?: string;
  metadata?: Record<string, unknown>;
}
