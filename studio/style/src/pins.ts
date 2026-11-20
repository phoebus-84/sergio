// ---------------------------------------------------------------------------
// What reads a style keeps a pin on it
// ---------------------------------------------------------------------------
// A unit that reads a style depends on it: change a colour of the palette and
// the bible written in it, the plans made from that bible, the takes made from
// those plans are no longer what the style says. The studio already has the
// mechanism for exactly this (ADR-0035): a pin, source/pins/<id>.json, holding
// an inventory of what was read. Status re-checks the inventory, and the
// stages that read a changed source — and everything downstream of them —
// are stale. Renewing the pin accepts the change and records which stages
// must be redone.
//
// So a unit under a styled level keeps one pin, `style`, on the style it
// reads. It is written when the unit is created under a style, when a style is
// applied above it, and when the style is read for it. If the style it reads
// moves (a scene gets a style of its own), the pin is pointed at the new one
// and keeps the old inventory: the unit is stale until renewed, because what
// it read is not what it would read now.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PINS_DIR, inventory, validateSourcePin, type SourcePin, type SourceRef } from "@studio/contracts/src/source-pins.mjs";
import { STYLE_BINDING, STYLE_PIN_ID } from "@studio/contracts/src/style.mjs";
import {
  nearestStyledTarget, sameTarget, styleDirOf, unitDirOf, unitLevel, unitsUnder,
  type StyleTarget, type UnitLevel, type UnitRef,
} from "./levels.js";

/**
 * The stages that read a style, by the level of the unit. A pin names them;
 * the runtime makes them and everything downstream of them stale when the
 * style changes. A name the unit's pipeline does not have is ignored, and a
 * pin that names none of its stages makes every stage stale — the safe way
 * round for a pipeline nobody told this list about.
 */
export const STYLE_READERS: Readonly<Record<UnitLevel, readonly string[]>> = Object.freeze({
  film: ["bible"],
  scene: ["direction"],
  shot: ["plan", "media"],
  episode: ["brief", "art-direction", "illustrations", "spec", "pictures", "scene-plan"],
});

export const stylePinPath = (root: string, ref: UnitRef): string => join(unitDirOf(root, ref), PINS_DIR, `${STYLE_PIN_ID}.json`);

export const styleSource = (target: StyleTarget): SourceRef => (target.series ? { kind: "style", series: target.series } : { kind: "style" });

/** The target a style pin points at, or null when the file is not a style pin. */
export function pinnedTarget(ref: UnitRef, pin: unknown): StyleTarget | null {
  const source = (pin as SourcePin | null)?.source;
  if (!source || source.kind !== "style") return null;
  return source.series ? { project: ref.channel, series: source.series } : { project: ref.channel };
}

export function readStylePin(root: string, ref: UnitRef): SourcePin | null {
  const file = stylePinPath(root, ref);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as SourcePin;
  } catch {
    return null;
  }
}

/**
 * What of a style a unit reads: everything in style/ but style.yaml, which
 * only says where the style came from. Copying a film's style into a scene
 * rewrites the binding and nothing a unit reads.
 */
export function styleReadPaths(styleDir: string): string[] {
  return readdirSync(styleDir).filter((name) => name !== STYLE_BINDING && !name.startsWith(".") && !name.startsWith("_")).sort();
}

let temporaries = 0;
function writeAtomically(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${(temporaries += 1)}.tmp`;
  writeFileSync(temporary, content, "utf-8");
  renameSync(temporary, target);
}

export type PinOutcome = "pinned" | "kept" | "moved" | "unstyled";

/**
 * Make a unit's style pin say which style it reads. A new pin inventories the
 * style as it is; an existing pin on the same style is left alone (accepting a
 * change is renewal, not this); a pin on another style is pointed at the new
 * one and keeps what it read, so the unit shows as stale.
 */
export async function syncStylePin(root: string, ref: UnitRef, now = new Date()): Promise<{ unit: UnitRef; outcome: PinOutcome; target: StyleTarget | null }> {
  const target = nearestStyledTarget(root, ref);
  if (!target) return { unit: ref, outcome: "unstyled", target: null };
  const file = stylePinPath(root, ref);
  const existing = readStylePin(root, ref);
  const was = existing ? pinnedTarget(ref, existing) : null;
  if (existing && was && sameTarget(was, target)) return { unit: ref, outcome: "kept", target };
  if (existing && was) {
    // What it read is kept; what it would read now is the new style's, all of it.
    const moved = { ...existing, source: styleSource(target), paths: styleReadPaths(styleDirOf(root, target)) };
    writeAtomically(file, `${JSON.stringify(moved, null, 2)}\n`);
    return { unit: ref, outcome: "moved", target };
  }
  const pin = {
    apiVersion: "studio.video/v1alpha1",
    kind: "SourcePin",
    id: STYLE_PIN_ID,
    source: styleSource(target),
    usedBy: [...STYLE_READERS[unitLevel(root, ref)]],
    paths: styleReadPaths(styleDirOf(root, target)),
    pinnedAt: now.toISOString(),
    files: await inventory(styleDirOf(root, target), styleReadPaths(styleDirOf(root, target))),
  };
  const problems = validateSourcePin(pin);
  if (problems.length > 0) throw new Error(`the style pin of ${ref.channel}/${ref.series}/${ref.episode} does not hold: ${problems[0]!.path} ${problems[0]!.message}`);
  writeAtomically(file, `${JSON.stringify(pin, null, 2)}\n`);
  return { unit: ref, outcome: "pinned", target };
}

/** Sync the style pin of every unit under a target. */
export async function syncStylePins(root: string, target: StyleTarget, now = new Date()) {
  const out = [];
  for (const unit of unitsUnder(root, target)) out.push(await syncStylePin(root, unit, now));
  return out;
}

/** The units whose style pin points at a target: what a change to its style makes stale. */
export function dependentsOf(root: string, target: StyleTarget): UnitRef[] {
  return unitsUnder(root, { project: target.project }).filter((unit) => {
    const pinned = pinnedTarget(unit, readStylePin(root, unit));
    return pinned !== null && sameTarget(pinned, target);
  });
}
