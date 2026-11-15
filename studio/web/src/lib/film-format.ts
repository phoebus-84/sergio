/** How a film's lengths and instants are written for a person. */

export { formatRuntime, timecode } from "@studio/contracts/src/film.mjs";

/** `1:02:03` or `2:03`: a running time in a column of them. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "–";
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function bytes(size: number | null | undefined): string {
  if (size === null || size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** A slug from a title, as a person would have typed it: lowercase words joined by hyphens. */
export function slugify(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/** The next number for a new scene or shot, in tens: 010, 020, 030 leave room to insert between. */
export function nextNumber(slugs: readonly string[]): string {
  const numbers = slugs.map((slug) => Number(/^(\d+)/.exec(slug)?.[1])).filter((n) => Number.isFinite(n));
  const next = numbers.length > 0 ? Math.floor(Math.max(...numbers) / 10) * 10 + 10 : 10;
  return String(next).padStart(3, "0");
}
