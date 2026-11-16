import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelPath, episodePath, seriesPath } from "@studio/contracts/src/layout.mjs";
import { declaredPipeline, defaultPipeline, pipelineOf, PipelineDeclarationError } from "../../../src/pipeline/declared.js";

/** The pipeline the library declares for an episode (avg-sxk). */

const REF = { channel: "dentro-i-versi", series: "long", episode: "il-lampo" };
let root: string;
const at = {
  episode: () => episodePath(root, REF.channel, REF.series, REF.episode),
  series: () => seriesPath(root, REF.channel, REF.series),
  channel: () => channelPath(root, REF.channel),
};
function declare(level: keyof typeof at, body: string) {
  mkdirSync(at[level](), { recursive: true });
  writeFileSync(join(at[level](), "pipeline.yaml"), body);
}
function refusal(): PipelineDeclarationError {
  try {
    declaredPipeline(root, REF);
  } catch (e) {
    if (e instanceof PipelineDeclarationError) return e;
    throw e;
  }
  throw new Error("expected a PipelineDeclarationError");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "declared-pipeline-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("declaredPipeline", () => {
  it("answers null when nothing declares one", () => {
    mkdirSync(at.episode(), { recursive: true });
    expect(declaredPipeline(root, REF)).toBeNull();
  });

  it("takes the channel's, the series' over it, and the episode's over both", () => {
    declare("channel", "pipeline: narrated-illustrated-video\n");
    expect(declaredPipeline(root, REF)).toEqual({ name: "narrated-illustrated-video", file: "dentro-i-versi/pipeline.yaml" });
    declare("series", "# the series family\npipeline: series-production\n");
    expect(declaredPipeline(root, REF)).toEqual({ name: "series-production", file: "dentro-i-versi/series/long/pipeline.yaml" });
    declare("episode", "pipeline: blender-animation\n");
    expect(declaredPipeline(root, REF)).toEqual({ name: "blender-animation", file: "dentro-i-versi/series/long/episodes/il-lampo/pipeline.yaml" });
  });

  it("skips a file without the key, an empty one and a comment-only one", () => {
    declare("channel", "pipeline: series-production\n");
    declare("series", "settings:\n  voice: serena\n");
    declare("episode", "");
    expect(declaredPipeline(root, REF)?.name).toBe("series-production");
    declare("episode", "# nothing yet\n\n");
    expect(declaredPipeline(root, REF)?.name).toBe("series-production");
  });

  it("refuses a file that does not parse, naming it", () => {
    declare("channel", "pipeline: series-production\n");
    declare("series", "pipeline: [unclosed\n");
    const e = refusal();
    expect([e.code, e.file]).toEqual(["bad-declaration", "dentro-i-versi/series/long/pipeline.yaml"]);
  });

  it("refuses a file that is not a mapping", () => {
    declare("series", "- series-production\n");
    expect(refusal().code).toBe("bad-declaration");
  });

  it("takes the id of a pipeline defined inline under the key", () => {
    declare("episode", 'pipeline:\n  id: blender-animation\n  version: "0.1.0"\n  stages: []\n');
    expect(declaredPipeline(root, REF)?.name).toBe("blender-animation");
    declare("episode", "pipeline:\n  stages: []\n");
    expect(refusal().code).toBe("bad-name");
  });

  it("names a long bad value briefly", () => {
    declare("series", `pipeline: [${Array.from({ length: 200 }, (_, i) => `stage-${i}`).join(", ")}]\n`);
    const e = refusal();
    expect(e.code).toBe("bad-name");
    expect(e.message.length).toBeLessThan(200);
  });

  it("refuses a name that is not a pipeline id", () => {
    for (const name of ["../x", "Series Production", "42"]) {
      declare("series", `pipeline: ${name}\n`);
      expect(refusal().code).toBe("bad-name");
    }
    declare("series", "pipeline: 42\n");
    expect(refusal().message).toContain("42");
  });
});

describe("a film's pipelines (ADR-0050)", () => {
  const film = { channel: "tide", series: "_", episode: "_" };
  const scene = { channel: "tide", series: "010-shore", episode: "_" };
  const shot = { channel: "tide", series: "010-shore", episode: "020-wave" };
  const other = { channel: "tide", series: "020-lamp", episode: "010-flame" };
  const write = (dir: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pipeline.yaml"), body);
  };
  beforeEach(() => {
    mkdirSync(join(root, "tide"), { recursive: true });
    writeFileSync(join(root, "tide", "film.yaml"), "kind: Film\n");
    for (const ref of [shot, other]) mkdirSync(episodePath(root, ref.channel, ref.series, ref.episode), { recursive: true });
  });

  it("gives each level its own default", () => {
    expect(defaultPipeline(root, film)).toBe("film-project");
    expect(defaultPipeline(root, scene)).toBe("film-scene");
    expect(defaultPipeline(root, shot)).toBe("film-shot");
    expect(defaultPipeline(root, REF)).toBe("narrated-illustrated-video");
    expect(declaredPipeline(root, shot)).toBeNull();
    expect(pipelineOf(root, shot)).toBe("film-shot");
  });

  it("lets a level name the pipeline of the levels below it", () => {
    write(join(root, "tide"), "pipeline: film-project\nscenes: film-scene-auto\nshots: film-shot-auto\n");
    // The film's own key is the film's, never its scenes' or shots'.
    expect(pipelineOf(root, film)).toBe("film-project");
    expect(declaredPipeline(root, scene)).toEqual({ name: "film-scene-auto", file: "tide/pipeline.yaml" });
    expect(pipelineOf(root, shot)).toBe("film-shot-auto");

    write(seriesPath(root, "tide", "010-shore"), "pipeline: film-scene\nshots: film-shot\n");
    expect(pipelineOf(root, scene)).toBe("film-scene");
    expect(declaredPipeline(root, shot)).toEqual({ name: "film-shot", file: "tide/scenes/010-shore/pipeline.yaml" });
    // Another scene's shots still follow the film.
    expect(pipelineOf(root, other)).toBe("film-shot-auto");

    write(episodePath(root, "tide", "010-shore", "020-wave"), "pipeline: blender-animation\n");
    expect(pipelineOf(root, shot)).toBe("blender-animation");
  });

  it("refuses a level's declaration that is not a pipeline id, naming the key", () => {
    write(join(root, "tide"), "shots: [a, b]\n");
    expect(() => declaredPipeline(root, shot)).toThrow(/tide\/pipeline.yaml declares shots' pipeline/);
  });
});
