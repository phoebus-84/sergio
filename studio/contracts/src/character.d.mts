// Type declarations for the character and cast manifests (ADR-0052).

export interface ManifestProblem {
  code: string;
  path: string;
  message: string;
}

export type FormMedium =
  | "rig-3d" | "model-3d" | "puppet-2d" | "sprites" | "vector" | "images" | "photo" | "graphic" | "sound" | "voice" | "other";
export type CharacterStatus = "draft" | "ready" | "retired";
export type RoleStanding = "lead" | "regular" | "guest" | "cameo" | "extra";

export interface CharacterDocuments {
  identity?: string;
  backstory?: string;
  performance?: string;
}

export interface CharacterVoice {
  profile?: string;
  motif?: string;
  language?: string;
  note?: string;
}

export interface CharacterLikeness {
  of: string;
  permission: string;
  evidence?: string;
}

export interface FormCan {
  actions?: string[];
  expressions?: string[];
  mouths?: string[];
  views?: string[];
  note?: string;
}

export interface FormMaker {
  tool: string;
  provider?: string;
  model?: string;
  note?: string;
}

export interface FormLicence {
  id: string;
  holder?: string;
  url?: string;
  attribution?: string;
  redistributable?: boolean;
}

export interface ReleaseTree {
  sha256: string;
  files: number;
  bytes: number;
}

export interface FormRelease {
  id: string;
  path: string;
  entry?: string;
  entrySha256?: string;
  tree: ReleaseTree;
  madeWith?: FormMaker[];
  licence?: FormLicence;
  note?: string;
  createdAt?: string;
}

export interface CharacterForm {
  id: string;
  medium: FormMedium;
  mediumNote?: string;
  title?: string;
  description?: string;
  can?: FormCan;
  current?: string;
  releases?: FormRelease[];
}

export interface CharacterManifest {
  apiVersion: "studio.video/v1alpha1";
  kind: "Character";
  id: string;
  name: string;
  summary?: string;
  nature?: string;
  status?: CharacterStatus;
  documents?: CharacterDocuments;
  voice?: CharacterVoice;
  likeness?: CharacterLikeness;
  forms?: CharacterForm[];
  defaultForm?: string;
  relations?: { to: string; note: string }[];
  tags?: string[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CastRole {
  role: string;
  name?: string;
  character: string;
  form?: string;
  release?: string;
  treeSha256?: string;
  standing?: RoleStanding;
  voice?: string;
  note?: string;
}

export interface CastManifest {
  apiVersion: "studio.video/v1alpha1";
  kind: "Cast";
  roles: CastRole[];
  note?: string;
  metadata?: Record<string, unknown>;
}

export const CHARACTER_API_VERSION: "studio.video/v1alpha1";
export const CHARACTERS_DIR: "characters";
export const CHARACTER_MANIFEST: "character.yaml";
export const CAST_MANIFEST: "cast.yaml";
export const FORMS_DIR: "forms";
export const FORM_MEDIA: readonly FormMedium[];
export const CHARACTER_STATUSES: readonly CharacterStatus[];
export const ROLE_STANDINGS: readonly RoleStanding[];
export const FORM_MEDIUM_DESCRIPTIONS: Readonly<Record<FormMedium, string>>;

export function validateCharacter(doc: unknown): ManifestProblem[];
export function validateCast(doc: unknown): ManifestProblem[];
export function defaultFormOf(character: CharacterManifest): CharacterForm | null;
export function currentReleaseOf(form: CharacterForm): FormRelease | null;
export function parseCharacterRef(ref: string): { owner: string[] | null; id: string };
export function cannot(form: CharacterForm, asked: Pick<FormCan, "actions" | "expressions" | "mouths" | "views">): Required<Pick<FormCan, "actions" | "expressions" | "mouths" | "views">>;
