import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerReviewRoutes } from "../src/routes/reviews.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeApp() {
  const root = await mkdtemp(join(tmpdir(), "gw-reviews-"));
  roots.push(root);
  const app = Fastify();
  registerReviewRoutes(app, { root });
  await app.ready();
  return { app, root };
}

describe("review routes", () => {
  it("persists an initial operator message when a thread is created with a body", async () => {
    const { app, root } = await makeApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/channels/childrens/series/fairy-tales/episodes/the-wolf-and-the-seven-little-kids/reviews",
      payload: {
        anchor: "render/render-002.mp4",
        body: "The wolf's eyes read as too scary for the target age.",
      },
    });
    expect(res.statusCode).toBe(201);
    const thread = res.json();
    expect(thread.anchor).toBe("render/render-002.mp4");
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.author).toBe("operator");
    expect(thread.messages[0]!.body).toBe("The wolf's eyes read as too scary for the target age.");
    expect(thread.messages[0]!.status).toBe("open");

    const disk = JSON.parse(
      await readFile(
        // Inside the episode, where everything else about it is (layout 2).
        join(root, "childrens", "series", "fairy-tales", "episodes", "the-wolf-and-the-seven-little-kids", "reviews", `${thread.id}.json`),
        "utf-8",
      ),
    );
    expect(disk.messages).toHaveLength(1);
    expect(disk.messages[0]!.body).toContain("too scary");

    await app.close();
  });

  it("still lists and answers a thread written where threads used to go", async () => {
    const { app, root } = await makeApp();
    const legacy = join(root, "childrens", "fairy-tales", "the-wolf", "reviews");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "rth-old.json"), JSON.stringify({ id: "rth-old", anchor: "script", episodeSlug: "childrens/fairy-tales/the-wolf", messages: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
    const base = "/api/channels/childrens/series/fairy-tales/episodes/the-wolf/reviews";
    const fresh = (await app.inject({ method: "POST", url: base, payload: { anchor: "render/current" } })).json();
    const listed = (await app.inject({ method: "GET", url: base })).json().threads.map((t: { id: string }) => t.id).sort();
    expect(listed).toEqual([fresh.id, "rth-old"].sort());
    expect((await app.inject({ method: "GET", url: `${base}/rth-old` })).statusCode).toBe(200);
    await app.close();
  });

  it("keeps a film unit's threads in the unit: the scene's own, and the film's", async () => {
    const { app, root } = await makeApp();
    await mkdir(join(root, "tide", "scenes", "010-shore"), { recursive: true });
    await writeFile(join(root, "tide", "film.yaml"), "kind: Film\n");
    const scene = (await app.inject({ method: "POST", url: "/api/channels/tide/series/010-shore/episodes/_/reviews", payload: { anchor: "cut/clip/020-wave", body: "Hold this two beats longer." } })).json();
    await readFile(join(root, "tide", "scenes", "010-shore", "reviews", `${scene.id}.json`), "utf-8");
    const film = (await app.inject({ method: "POST", url: "/api/channels/tide/series/_/episodes/_/reviews", payload: { anchor: "render/current" } })).json();
    await readFile(join(root, "tide", "reviews", `${film.id}.json`), "utf-8");
    await app.close();
  });

  it("creates an empty thread when no body is supplied", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/channels/wordless-comedy/series/give-me-time/episodes/the-run-up/reviews",
      payload: { anchor: "render/current" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().messages).toEqual([]);
    await app.close();
  });
});
