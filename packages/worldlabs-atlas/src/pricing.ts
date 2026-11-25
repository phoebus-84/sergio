// ---------------------------------------------------------------------------
// What a task costs
// ---------------------------------------------------------------------------
// Atlas is paid in credits, 1,000 to the dollar. Its documentation prices
// one task, a splat; for the rest it says to "use the current rate card
// shown in the platform … rather than embedding model prices in client
// code". So a price is one of three things, and says which:
//
// - published: in the documentation, below, with the page it is on;
// - operator:  given by whoever holds the account, from its rate card, and
//              used before a published one, since the card can change;
// - unknown:   nobody said. An unknown price is never guessed: a caller with
//              a budget must refuse the call.
//
// An operation does not say what it was charged. What a run cost is its
// price here, or the account's Usage page.
// ---------------------------------------------------------------------------

import type { AtlasTask } from "./types.js";

/** "The current conversion is 1,000 credits per US dollar." (Billing) */
export const CREDITS_PER_USD = 1000;

/**
 * A price's name: a task, or a task with the variant that sets its price.
 * `atlasGenerate.perView` is this package's guess at how a render is
 * metered, per target camera: the rate card may say otherwise.
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

/** "Refined (the default): 5,000 credits ($5). Draft, with refine: false: 500 credits ($0.50)." (Posed images to splats, 2026-11-25) */
export const PUBLISHED_CREDITS: Readonly<Partial<Record<PriceKey, number>>> = {
  "posedImages2Splats.draft": 500,
  "posedImages2Splats.refined": 5000,
};

/** Tasks whose page says a run that fails costs nothing: "Each successful run costs … Failed runs are free." */
export const FAILED_RUNS_FREE: readonly AtlasTask[] = ["posedImages2Splats"];

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
  // Refining is the default there: a request that does not say is priced as refined.
  if (task === "posedImages2Splats") return { key: request.refine === false ? "posedImages2Splats.draft" : "posedImages2Splats.refined", units: 1 };
  if (task === "atlasGenerate") return { key: "atlasGenerate.perView", units: Math.max(1, request.views ?? 1) };
  return { key: task, units: 1 };
}

/** What a request is expected to cost. */
export function estimate(task: AtlasTask, request: { refine?: boolean; views?: number } = {}, operator: OperatorCredits = {}): AtlasEstimate {
  const { key, units } = priceKeyOf(task, request);
  const own = operator[key], published = PUBLISHED_CREDITS[key];
  const each = valid(own) ? own : valid(published) ? published : null;
  if (each === null) return { key, units, credits: 0, usd: 0, priced: false, basis: "unknown" };
  const credits = each * units;
  return { key, units, credits, usd: creditsToUsd(credits), priced: true, basis: valid(own) ? "operator" : "published" };
}

const valid = (credits: number | undefined): credits is number => typeof credits === "number" && Number.isFinite(credits) && credits >= 0;

/** The price list as lines a person reads. */
export function describePrices(operator: OperatorCredits = {}): string[] {
  return PRICE_KEYS.map((key) => {
    const own = operator[key], published = PUBLISHED_CREDITS[key];
    if (valid(own)) return `${key}: ${own} credits ($${creditsToUsd(own)}), the operator's`;
    if (valid(published)) return `${key}: ${published} credits ($${creditsToUsd(published)}), published`;
    return `${key}: not known`;
  });
}
