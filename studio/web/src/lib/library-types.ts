import type { EpisodeStatus, ProjectKind } from "$contracts/gateway";

/** A resolved library tree with all three levels populated. */
export interface LibraryTree {
  channels: ResolvedChannel[];
}

export interface ResolvedChannel {
  slug: string;
  title: string;
  /** A channel, or a film: the same three levels read as film, scene and shot. */
  kind: ProjectKind;
  series: ResolvedSeries[];
  error?: string;
}

export interface ResolvedSeries {
  slug: string;
  title: string;
  channel: string;
  /** A scene: the sequence and the act of the film it is in. */
  sequence?: string | null;
  act?: string | null;
  episodes: ResolvedEpisode[];
  error?: string;
}

export interface ResolvedEpisode {
  slug: string;
  title: string;
  channel: string;
  series: string;
  status: EpisodeStatus;
  currentDeliverable: boolean;
  blocked: boolean;
  staleCount: number;
  lastActivity: string;
  error?: string;
}

/** Compact display status derived from the episode state. */
export type EpisodeDisplayStatus =
  | "idle"
  | "running"
  | "awaiting_review"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale"
  | "malformed";

export function displayStatus(ep: ResolvedEpisode): EpisodeDisplayStatus {
  if (ep.error) return "malformed";
  if (ep.staleCount > 0 && ep.status !== "running") return "stale";
  if (ep.status === "blocked") return "blocked";
  if (ep.status === "failed") return "failed";
  return ep.status;
}

/** human labels */
export const STATUS_LABELS: Record<EpisodeDisplayStatus, string> = {
  idle: "Idle",
  running: "Running",
  awaiting_review: "Review",
  blocked: "Blocked",
  completed: "Current",
  failed: "Failed",
  cancelled: "Cancelled",
  stale: "Stale",
  malformed: "Repair",
};

export const STATUS_ORDER: Record<EpisodeDisplayStatus, number> = {
  running: 0,
  blocked: 1,
  awaiting_review: 2,
  stale: 3,
  failed: 4,
  completed: 5,
  idle: 6,
  cancelled: 7,
  malformed: 8,
};

/** What each level of a project is called, by the project's kind. */
export const LEVEL_NAMES: Record<ProjectKind, { project: string; group: string; unit: string; groups: string; units: string }> = {
  channel: { project: "channel", group: "series", unit: "episode", groups: "series", units: "episodes" },
  film: { project: "film", group: "scene", unit: "shot", groups: "scenes", units: "shots" },
};
