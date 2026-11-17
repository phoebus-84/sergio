/**
 * Shell UI state: which view is showing, which files are open, what the
 * inspector is looking at, and whether the palette is up.
 *
 * This is deliberately separate from the data stores. `library`, `episode` and
 * `files` answer "what exists"; this answers "what is the creator looking at".
 * Keeping them apart is what lets a reconnect or a live update refresh the data
 * without collapsing open tabs, resetting the inspector, or closing the palette
 * under the user's hands — which DESIGN.md calls out as a thing the studio must
 * not do.
 */

import { library } from "$lib/library-store.svelte.ts";

export type Level = "channel" | "series" | "episode";

export type View =
  | "overview"
  | "cut"
  | "footage"
  | "pipeline"
  | "stages"
  | "files"
  | "storyboard"
  | "narration"
  | "audio"
  | "music"
  | "render";

export type InspectorTab =
  | "cut"
  | "provenance"
  | "versions"
  | "logs"
  | "comments"
  | "run";

export interface ViewDef {
  key: View;
  label: string;
}

/**
 * Which views each level offers.
 *
 * A channel is an identity, a series is a format, an episode is a production —
 * so they do not get the same tabs. Offering "Render" on a channel would be
 * offering a button that cannot mean anything.
 */
export const VIEWS: Record<Level, ViewDef[]> = {
  channel: [
    { key: "overview", label: "Overview" },
    { key: "files", label: "Files" },
  ],
  series: [
    { key: "overview", label: "Overview" },
    { key: "pipeline", label: "Pipeline" },
    { key: "files", label: "Files" },
  ],
  episode: [
    { key: "stages", label: "Stages" },
    { key: "files", label: "Files" },
    { key: "storyboard", label: "Storyboard" },
    { key: "narration", label: "Narration" },
    { key: "audio", label: "Audio" },
    { key: "music", label: "Music" },
    { key: "render", label: "Render" },
  ],
};

/**
 * Which views each level of a film offers (ADR-0050).
 *
 * A film is produced at every level, so every level has a cut and stages: the
 * film's own, a scene's, a shot's. The overview is what the level is and what
 * is under it — the film as a board of scenes and shots, a scene as its shot
 * list, a shot as its plan and its takes.
 */
export const FILM_VIEWS: Record<Level, ViewDef[]> = {
  channel: [
    { key: "overview", label: "Board" },
    { key: "cut", label: "Cut" },
    { key: "footage", label: "Footage" },
    { key: "music", label: "Music" },
    { key: "stages", label: "Stages" },
    { key: "files", label: "Files" },
  ],
  series: [
    { key: "overview", label: "Scene" },
    { key: "cut", label: "Cut" },
    { key: "music", label: "Music" },
    { key: "stages", label: "Stages" },
    { key: "files", label: "Files" },
  ],
  episode: [
    { key: "overview", label: "Shot" },
    { key: "cut", label: "Cut" },
    { key: "music", label: "Music" },
    { key: "stages", label: "Stages" },
    { key: "files", label: "Files" },
  ],
};

/** The view a level lands on when you arrive at it. */
const DEFAULT_VIEW: Record<Level, View> = {
  channel: "overview",
  series: "overview",
  episode: "stages",
};

export interface AgentStatus {
  kind: "idle" | "working" | "unavailable" | "error";
  text: string;
}

class StudioStore {
  view = $state<View>("stages");
  inspectorTab = $state<InspectorTab>("provenance");

  /** Free-text filter over the library tree. */
  libraryFilter = $state("");

  /**
   * The side panels: open or put away, and how wide. Kept here rather than in
   * the shell so a view can ask what room it has — the cut shows its own
   * inspector when the shell's is away.
   */
  structureOpen = $state(true);
  inspectorOpen = $state(true);
  structureWidth = $state(260);
  inspectorWidth = $state(340);

  /**
   * Both side panels put away at once, for work that needs the width: a
   * timeline, a long document, a storyboard. Leaving focus brings back
   * whatever was open before; it does not forget a panel the person closed.
   */
  focus = $state(false);

  /** The agent bar folded down to its status line. */
  agentBarCollapsed = $state(false);

  get structureVisible(): boolean {
    return this.structureOpen && !this.focus;
  }

  get inspectorVisible(): boolean {
    return this.inspectorOpen && !this.focus;
  }

  paletteOpen = $state(false);
  paletteQuery = $state("");

  /** Open file tabs, by path, in the order they were opened. */
  openPaths = $state<string[]>([]);

  /** Draft text in the agent bar, and what Pi last told us. */
  agentDraft = $state("");
  agentStatus = $state<AgentStatus>({ kind: "idle", text: "Pi is idle" });

  /** Which level the library selection points at. */
  get level(): Level {
    if (library.selectedChannel) return "channel";
    if (library.selectedSeries) return "series";
    return "episode";
  }

  /** The kind of project the selection is in. */
  get kind(): "channel" | "film" {
    return library.selection?.kind ?? "channel";
  }

  get views(): ViewDef[] {
    return this.kind === "film" ? FILM_VIEWS[this.level] : VIEWS[this.level];
  }

  /**
   * Move to a view, refusing views the current level does not offer.
   *
   * Without the guard, switching level while on "Render" would leave the canvas
   * asking a channel for a video.
   */
  show(view: View): void {
    if (this.views.some((v) => v.key === view)) this.view = view;
  }

  /** Land on a level's default view. Called when the library selection moves. */
  resetView(): void {
    this.view = this.kind === "film" ? "overview" : DEFAULT_VIEW[this.level];
  }

  /** Open a file in a tab and focus the Files view. */
  openFile(path: string): void {
    if (!this.openPaths.includes(path)) this.openPaths = [...this.openPaths, path];
    this.view = "files";
  }

  closeFile(path: string): void {
    this.openPaths = this.openPaths.filter((p) => p !== path);
  }

  /** Drop every open tab. Used when the level changes, since paths are relative to it. */
  clearFiles(): void {
    this.openPaths = [];
  }

  // ── Layout, remembered across reloads ─────────────────────────────────

  static readonly #LAYOUT_KEY = "vs-panels";

  restoreLayout(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(StudioStore.#LAYOUT_KEY) ?? "{}") as Record<string, unknown>;
      if (typeof saved.structure === "boolean") this.structureOpen = saved.structure;
      if (typeof saved.inspector === "boolean") this.inspectorOpen = saved.inspector;
      if (typeof saved.structureWidth === "number") this.structureWidth = saved.structureWidth;
      if (typeof saved.inspectorWidth === "number") this.inspectorWidth = saved.inspectorWidth;
      if (typeof saved.focus === "boolean") this.focus = saved.focus;
      if (typeof saved.agentBar === "boolean") this.agentBarCollapsed = saved.agentBar;
    } catch { /* first run, or unreadable storage */ }
  }

  persistLayout(): void {
    try {
      localStorage.setItem(StudioStore.#LAYOUT_KEY, JSON.stringify({
        structure: this.structureOpen,
        inspector: this.inspectorOpen,
        structureWidth: this.structureWidth,
        inspectorWidth: this.inspectorWidth,
        focus: this.focus,
        agentBar: this.agentBarCollapsed,
      }));
    } catch { /* storage unavailable; the session still works */ }
  }

  toggleFocus(): void {
    this.focus = !this.focus;
    this.persistLayout();
  }

  /** Open or close one side panel. Asking for a panel while in focus leaves focus with that panel open. */
  togglePanel(side: "structure" | "inspector"): void {
    const key = side === "structure" ? "structureOpen" : "inspectorOpen";
    if (this.focus) {
      this.focus = false;
      this[key] = true;
    } else this[key] = !this[key];
    this.persistLayout();
  }

  resizePanel(side: "structure" | "inspector", width: number): void {
    // Dragging a collapsed panel's edge reopens it; otherwise the drag would set a width nobody can see.
    if (side === "structure") {
      this.structureWidth = width;
      this.structureOpen = true;
    } else {
      this.inspectorWidth = width;
      this.inspectorOpen = true;
    }
    this.focus = false;
    this.persistLayout();
  }

  toggleAgentBar(): void {
    this.agentBarCollapsed = !this.agentBarCollapsed;
    this.persistLayout();
  }

  togglePalette(): void {
    this.paletteOpen = !this.paletteOpen;
    if (!this.paletteOpen) this.paletteQuery = "";
  }

  closePalette(): void {
    this.paletteOpen = false;
    this.paletteQuery = "";
  }
}

export const studio = new StudioStore();
