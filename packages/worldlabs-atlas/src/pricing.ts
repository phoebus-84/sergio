// ---------------------------------------------------------------------------
// What a task costs
// ---------------------------------------------------------------------------
// Atlas is paid in credits. Only one task's price was public when this was
// written; the rest of the rate card is shown to a signed-in account. So a
// price is one of three things, and says which:
//
// - published: in PUBLISHED_CREDITS below, with where it was read;
// - operator:  given by whoever holds the account, from its rate card;
// - unknown:   nobody said. An unknown price is never guessed: a caller with
//              a budget must refuse the call.
//
// What an operation says it charged, when it says, replaces any of these.
// ---------------------------------------------------------------------------

import type { AtlasCost, AtlasOperation, AtlasTask } from "./types.js";

/** "The current conversion is 1,000 credits per US dollar", and "may change during beta". */
export const CREDITS_PER_USD = 1000;

/**
 * A price's name: a task, or a task with the variant that sets its price.
 * `atlasGenerate.perView` is charged once per target camera.
 */
export type PriceKey =
  | "images2PosedRGBD"
  | "posedImages2Splats.draft"
  | "posedImages2Splats.refined"
  | "splats2Mesh"
  | "atlasGenerate.perView"
  | "atlasChisel"
  | "atlasTextToImage";

export const PRICE_KEYS: readonly PriceKey[] = [
  "images2PosedRGBD", "posedImages2Splats.draft", "posedImages2Splats.refined", "splats2Mesh", "atlasGenerate.perView", "atlasChisel", "atlasTextToImage",
];

/** Prices that were public on 2026-11-25. Third-party reports of the provider's pages: see docs/notes/worldlabs-atlas-api.md. */
export const PUBLISHED_CREDITS: Readonly<Partial<Record<PriceKey, number>>> = {
  "posedImages2Splats.draft": 500,
  "posedImages2Splats.refined": 5000,
};

export type OperatorCredits = Readonly<Partial<Record<PriceKey, number>>>;

export interface AtlasEstimate {
  readonly key: PriceKey;
  /** How many times the price is charged: target cameras, for `atlasGenerate`. */
  readonly units: number;
  readonly credits: number;
  readonly usd: number;
  readonly priced: boolean;
  readonly basis: "published" | "operator" | "unknown";
}

export const creditsToUsd = (credits: number): number => Math.round((credits / CREDITS_PER_USD) * 1e6) / 1e6;

/** The price a request falls under, and how many times. */
export function priceKeyOf(task: AtlasTask, request: { refine?: boolean; views?: number } = {}): { key: PriceKey; units: number } {
  if (task === "posedImages2Splats") return { key: request.refine === false ? "posedImages2Splats.draft" : "posedImages2Splats.refined", units: 1 };
  if (task === "atlasGenerate") return { key: "atlasGenerate.perView", units: Math.max(1, request.views ?? 1) };
  return { key: task, units: 1 };
}

/** What a request is expected to cost. An operator's price is used before a published one: theirs is the account's. */
export function estimate(task: AtlasTask, request: { refine?: boolean; views?: number } = {}, operator: OperatorCredits = {}): AtlasEstimate {
  const { key, units } = priceKeyOf(task, request);
  const own = operator[key], published = PUBLISHED_CREDITS[key];
  const each = valid(own) ? own : valid(published) ? published : null;
  if (each === null) return { key, units, credits: 0, usd: 0, priced: false, basis: "unknown" };
  const credits = each * units;
  return { key, units, credits, usd: creditsToUsd(credits), priced: true, basis: valid(own) ? "operator" : "published" };
}

const valid = (credits: number | undefined): credits is number => typeof credits === "number" && Number.isFinite(credits) && credits >= 0;

/** What the provider says an operation cost, or null when it does not say. */
export function chargedFor(operation: AtlasOperation): AtlasCost | null {
  if (operation.credits === null) return null;
  return { credits: operation.credits, usd: creditsToUsd(operation.credits), basis: "provider" };
}

/** The price list as lines a person reads. */
export function describePrices(operator: OperatorCredits = {}): string[] {
  return PRICE_KEYS.map((key) => {
    const own = operator[key], published = PUBLISHED_CREDITS[key];
    if (valid(own)) return `${key}: ${own} credits ($${creditsToUsd(own)}), the operator's`;
    if (valid(published)) return `${key}: ${published} credits ($${creditsToUsd(published)}), published`;
    return `${key}: not known`;
  });
}
