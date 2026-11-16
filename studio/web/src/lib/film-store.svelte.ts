/**
 * The selected film: its tree of scenes and shots, its footage, and what the
 * studio can ask of it — make a scene or a shot, reorder, change a manifest,
 * say who decides, render.
 *
 * The tree is the gateway's reading of the library, never a copy kept in
 * step by hand: every change here is a request followed by a reload, and a
 * change made elsewhere — the agent editing a cut, a render finishing —
 * arrives as an event and reloads it too.
 */

import { filmApi, FilmApiError } from "./film-api";
import { onGatewayEvent } from "./gateway.svelte.ts";
import { library } from "./library-store.svelte.ts";
import {
  unitKey, unitPath,
  type EffectDefinition, type FilmLevel, type FilmTree, type FootageClip, type SceneNode, type ShotNode, type UnitNode,
} from "./film-types";
import type { FilmFormat } from "@studio/contracts/src/film.mjs";

export interface Unit {
  film: string;
  scene: string;
  shot: string;
}

export interface UnitControl {
  level: FilmLevel;
  pipeline: string;
  declared: Record<string, string | null>;
  defaults: Record<FilmLevel, string>;
}

export interface RenderEvent {
  kind: "progress" | "completed" | "failed";
  unit: string;
  quality: "final" | "preview";
  message: string;
  at: number;
  url?: string;
}

class FilmStore {
  film = $state<string | null>(null);
  tree = $state<FilmTree | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  footage = $state<FootageClip[]>([]);
  footageLoaded = $state<string | null>(null);

  /** The catalogs: what a film can be delivered as, and what a cut can do. Loaded once. */
  formats = $state<FilmFormat[]>([]);
  effects = $state<EffectDefinition[]>([]);

  /** The last thing a render said, for the status line. */
  lastRender = $state<RenderEvent | null>(null);
  /** What the last request refused, in the gateway's words. */
  notice = $state<{ tone: "error" | "info"; text: string } | null>(null);

  #listening = false;
  #reload: ReturnType<typeof setTimeout> | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;

  get rendering(): FilmTree["rendering"] {
    return this.tree?.rendering ?? null;
  }

  /** A unit of the tree by its position. */
  node(unit: Unit): UnitNode<unknown> | null {
    const tree = this.tree;
    if (!tree || tree.slug !== unit.film) return null;
    if (unit.scene === "_") return tree;
    const scene = tree.scenes.find((s) => s.slug === unit.scene);
    if (!scene) return null;
    if (unit.shot === "_") return scene;
    return scene.shots.find((s) => s.slug === unit.shot) ?? null;
  }

  scene(slug: string): SceneNode | null {
    return this.tree?.scenes.find((s) => s.slug === slug) ?? null;
  }

  shot(scene: string, slug: string): ShotNode | null {
    return this.scene(scene)?.shots.find((s) => s.slug === slug) ?? null;
  }

  /** Point the store at a film and read it. Reading again is how it is kept current. */
  async load(film: string): Promise<void> {
    this.#listen();
    if (this.film !== film) {
      this.film = film;
      this.tree = null;
      this.footage = [];
      this.footageLoaded = null;
      this.lastRender = null;
      this.notice = null;
    }
    await this.refresh();
    void this.#catalogs();
  }

  async refresh(): Promise<void> {
    const film = this.film;
    if (!film) return;
    this.loading = this.tree === null;
    try {
      const tree = await filmApi<FilmTree>(`/api/films/${encodeURIComponent(film)}/tree`);
      if (this.film !== film) return;
      this.tree = tree;
      this.error = null;
      this.#watchRender();
    } catch (error) {
      if (this.film === film) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
    }
  }

  /** Reload soon: several events arrive together when a render cascades. */
  refreshSoon(): void {
    if (this.#reload) return;
    this.#reload = setTimeout(() => {
      this.#reload = null;
      void this.refresh();
    }, 250);
  }

  async #catalogs(): Promise<void> {
    if (this.effects.length > 0) return;
    try {
      const [formats, effects] = await Promise.all([
        filmApi<FilmFormat[]>("/api/film-formats"),
        filmApi<EffectDefinition[]>("/api/cut-effects"),
      ]);
      this.formats = formats;
      this.effects = effects;
    } catch { /* the forms that need them say they are not loaded */ }
  }

  #listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    onGatewayEvent((event) => {
      const type = String(event.type ?? "");
      const data = (event.data ?? {}) as Record<string, unknown>;
      const unit = typeof data.unit === "string" ? data.unit : "";
      if (!this.film || !unit.startsWith(`${this.film}/`)) return;
      if (type === "render.progress") {
        const tree = this.tree;
        if (tree?.rendering) {
          tree.rendering.progress = { unit: String(data.unit), phase: String(data.phase), done: Number(data.done), total: Number(data.total) };
        } else this.refreshSoon();
        return;
      }
      if (type === "render.completed") {
        this.lastRender = {
          kind: "completed", unit, quality: data.quality === "preview" ? "preview" : "final", at: Date.now(),
          message: data.reused ? "already rendered: nothing had changed" : `rendered ${String(data.renderId ?? "")}`,
          ...(typeof data.url === "string" ? { url: data.url } : {}),
        };
      } else if (type === "render.failed") {
        this.lastRender = { kind: "failed", unit, quality: data.quality === "preview" ? "preview" : "final", at: Date.now(), message: String(data.message ?? "the render failed") };
      }
      if (type.startsWith("render.") || type.startsWith("cut.") || type.startsWith("unit.")) this.refreshSoon();
    });
  }

  /** While a render runs, read the tree now and then: a missed event must not leave a bar that never ends. */
  #watchRender(): void {
    if (this.rendering && !this.#poll) {
      this.#poll = setInterval(() => void this.refresh(), 2500);
    } else if (!this.rendering && this.#poll) {
      clearInterval(this.#poll);
      this.#poll = null;
    }
  }

  async #request<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      const result = await work();
      this.notice = null;
      return result;
    } catch (error) {
      const problems = error instanceof FilmApiError ? error.problems.slice(0, 3).map((p) => `${p.path} ${p.message}`).join("; ") : "";
      this.notice = { tone: "error", text: `${error instanceof Error ? error.message : String(error)}${problems && !(error as Error).message.includes(problems) ? ` — ${problems}` : ""}` };
      return null;
    }
  }

  // ── Making and ordering ───────────────────────────────────────────────

  async createScene(input: Record<string, unknown>): Promise<boolean> {
    const film = this.film;
    if (!film) return false;
    const made = await this.#request(() => filmApi(`/api/films/${encodeURIComponent(film)}/scenes`, { method: "POST", body: input }));
    await Promise.all([this.refresh(), library.reload()]);
    return made !== null;
  }

  async createShot(scene: string, input: Record<string, unknown>): Promise<boolean> {
    const film = this.film;
    if (!film) return false;
    const made = await this.#request(() => filmApi(`/api/films/${encodeURIComponent(film)}/scenes/${encodeURIComponent(scene)}/shots`, { method: "POST", body: input }));
    await Promise.all([this.refresh(), library.reload()]);
    return made !== null;
  }

  /** Change a unit's manifest: fields to set (null removes one) and, for a film or a scene, the order of what is under it. */
  async saveManifest(unit: Unit, change: { set?: Record<string, unknown>; order?: string[] }): Promise<boolean> {
    const saved = await this.#request(() => filmApi(`${unitPath(unit)}/manifest`, { method: "PUT", body: change }));
    // A title or an order changed is a change to the library's tree too.
    await Promise.all([this.refresh(), library.reload()]);
    return saved !== null;
  }

  /** Move a scene of the film, or a shot of a scene, one place earlier or later. */
  async move(unit: Unit, slug: string, by: -1 | 1): Promise<void> {
    const tree = this.tree;
    if (!tree) return;
    const order = unit.scene === "_" ? tree.scenes.map((s) => s.slug) : (this.scene(unit.scene)?.shots.map((s) => s.slug) ?? []);
    const from = order.indexOf(slug);
    const to = from + by;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    await this.saveManifest(unit, { order });
  }

  // ── Who decides ───────────────────────────────────────────────────────

  async control(unit: Unit): Promise<UnitControl | null> {
    return this.#request(() => filmApi<UnitControl>(`${unitPath(unit)}/control`));
  }

  async setControl(unit: Unit, change: Record<string, string | null>): Promise<UnitControl | null> {
    return this.#request(() => filmApi<UnitControl>(`${unitPath(unit)}/control`, { method: "PUT", body: change }));
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  async render(unit: Unit, options: { quality: "final" | "preview"; from?: number; to?: number; force?: boolean }): Promise<boolean> {
    const started = await this.#request(() => filmApi(`${unitPath(unit)}/cut/render`, { method: "POST", body: options }));
    if (started) this.lastRender = { kind: "progress", unit: unitKey(unit), quality: options.quality, message: "started", at: Date.now() };
    await this.refresh();
    return started !== null;
  }

  async stopRender(): Promise<void> {
    const film = this.film;
    if (!film) return;
    await this.#request(() => filmApi(`/api/films/${encodeURIComponent(film)}/render`, { method: "DELETE" }));
  }

  // ── Footage ───────────────────────────────────────────────────────────

  async loadFootage(force = false): Promise<void> {
    const film = this.film;
    if (!film || (!force && this.footageLoaded === film)) return;
    const clips = await this.#request(() => filmApi<FootageClip[]>(`/api/films/${encodeURIComponent(film)}/footage`));
    if (clips && this.film === film) {
      this.footage = clips;
      this.footageLoaded = film;
    }
  }

  async ingest(files: string[], options: Record<string, unknown> = {}): Promise<boolean> {
    const film = this.film;
    if (!film) return false;
    const done = await this.#request(() => filmApi(`/api/films/${encodeURIComponent(film)}/footage`, { method: "POST", body: { files, ...options } }));
    await this.loadFootage(true);
    return done !== null;
  }

  async annotate(id: string, change: Record<string, unknown>): Promise<void> {
    const film = this.film;
    if (!film) return;
    await this.#request(() => filmApi(`/api/films/${encodeURIComponent(film)}/footage/${encodeURIComponent(id)}`, { method: "PATCH", body: change }));
    await this.loadFootage(true);
  }
}

export const film = new FilmStore();
