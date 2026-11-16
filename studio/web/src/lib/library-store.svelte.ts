import type { LibraryTree } from "$lib/library-types";
import type { GatewayClient } from "$contracts/client";
import type { EpisodeSummary, SeriesSummary } from "$contracts/gateway";
import { buildFixtureTree } from "$lib/fixtures";

export type LibraryState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "empty" }
  | { phase: "ready"; tree: LibraryTree };

/**
 * Reactive library store using Svelte 5 runes.
 * Supports both fixture and gateway-backed loading.
 */
class LibraryStore {
  tree = $state<LibraryTree>({ channels: [] });
  phase = $state<LibraryState["phase"]>("loading");
  message = $state("");
  selectedEpisode = $state<string | null>(null);
  selectedChannel = $state<string | null>(null);
  selectedSeries = $state<{ channel: string; series: string } | null>(null);

  /**
   * Whether what is shown was read from a gateway. Things can be made — a
   * film started — only in a real library; the fixtures are something to
   * look at.
   */
  live = $state(false);

  /** Load from a fixture (test / no-gateway mode). */
  loadFixture(tree: LibraryTree) {
    this.live = false;
    this.tree = tree;
    this.phase = tree.channels.length === 0 ? "empty" : "ready";
    this.message = "";
  }

  #client: GatewayClient | null = null;

  /** Load from the gateway API. */
  async loadFromGateway(client: GatewayClient) {
    this.#client = client;
    this.phase = "loading";
    try {
      await this.#read(client);
    } catch (err) {
      this.loadError(err instanceof Error ? err.message : "Gateway unavailable");
    }
  }

  /**
   * Read the library again, keeping what is shown until the new reading is
   * in: a scene added to a film appears in the tree without the tree blinking.
   */
  async reload(): Promise<void> {
    if (!this.#client) return;
    try {
      await this.#read(this.#client);
    } catch { /* what was shown stays; the next reading may succeed */ }
  }

  async #read(client: GatewayClient): Promise<void> {
    const channels = await client.listChannels();
    this.live = true;
    if (channels.length === 0) {
      this.phase = "empty";
      this.tree = { channels: [] };
      return;
    }

    // Every project at once, and every series of a project at once: a library
    // of ten series used to be read with forty requests one after another.
    const seriesByChannel: Record<string, SeriesSummary[]> = {};
    const episodesBySeries: Record<string, EpisodeSummary[]> = {};
    await Promise.all(channels.map(async (ch) => {
      const series = await client.listSeries(ch.slug);
      seriesByChannel[ch.slug] = series;
      await Promise.all(series.map(async (ser) => {
        episodesBySeries[`${ch.slug}/${ser.slug}`] = await client.listEpisodes(ch.slug, ser.slug);
      }));
    }));

    this.tree = buildFixtureTree({ channels, seriesByChannel, episodesBySeries });
    this.phase = "ready";
    this.message = "";
  }

  /** What kind of project a slug names: a film, or (by default) a channel. */
  kindOf(channel: string | null | undefined): "channel" | "film" {
    return this.tree.channels.find((c) => c.slug === channel)?.kind ?? "channel";
  }

  /**
   * What is selected, as one reference: its level, the project's kind, and the
   * three positions every route of the gateway takes. In a film the level
   * itself is `_`: a scene's own unit is (film, scene, _), the film's
   * (film, _, _).
   */
  get selection(): { kind: "channel" | "film"; level: "channel" | "series" | "episode"; channel: string; series: string | null; episode: string | null } | null {
    if (this.selectedChannel) {
      return { kind: this.kindOf(this.selectedChannel), level: "channel", channel: this.selectedChannel, series: null, episode: null };
    }
    if (this.selectedSeries) {
      const { channel, series } = this.selectedSeries;
      return { kind: this.kindOf(channel), level: "series", channel, series, episode: null };
    }
    if (this.selectedEpisode) {
      const [channel, series, episode] = this.selectedEpisode.split("/");
      if (channel && series && episode) return { kind: this.kindOf(channel), level: "episode", channel, series, episode };
    }
    return null;
  }

  /** The selected film unit, or null when what is selected is not in a film. */
  get filmUnit(): { film: string; scene: string; shot: string; level: "film" | "scene" | "shot" } | null {
    const selected = this.selection;
    if (!selected || selected.kind !== "film") return null;
    return {
      film: selected.channel,
      scene: selected.series ?? "_",
      shot: selected.episode ?? "_",
      level: selected.level === "channel" ? "film" : selected.level === "series" ? "scene" : "shot",
    };
  }

  /** Load error state. */
  loadError(message: string) {
    this.phase = "error";
    this.message = message;
    this.tree = { channels: [] };
  }

  /** Mark an episode as selected. */
  select(channel: string, series: string, episode: string) {
    this.selectedEpisode = `${channel}/${series}/${episode}`;
    this.selectedChannel = null;
    this.selectedSeries = null;
  }

  /** Select channel level (no episode). */
  selectChannel(channel: string) {
    this.selectedChannel = channel;
    this.selectedSeries = null;
    this.selectedEpisode = null;
  }

  /** Select series level (no episode). */
  selectSeries(channel: string, series: string) {
    this.selectedSeries = { channel, series };
    this.selectedEpisode = null;
    this.selectedChannel = null;
  }

  /** Deselect everything. */
  deselect() {
    this.selectedEpisode = null;
    this.selectedChannel = null;
    this.selectedSeries = null;
  }
}

export const library = new LibraryStore();
