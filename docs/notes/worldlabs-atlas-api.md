# World Labs Atlas API: what is known, and how

Notes taken on 2026-11-25 while writing `@av/worldlabs-atlas`
([ADR-0057](../adr/0057-atlas-builds-location-sets-behind-world-capabilities.md)).
They are a record of evidence, not a copy of the documentation.

## Read this first: the documentation itself was not read

The official pages (`https://docs.atlas.worldlabs.ai/…`) could not be opened
from the machine these notes were written on: its network policy allowed no
outside host, and every fetch failed before reaching the site. No page text,
no JSON example and no OpenAPI schema was seen.

What follows comes from two weaker kinds of source, and each line says which:

- **[S]** a web search engine's summary of an official World Labs page. The
  page exists and the summary is of its text, but the wording here is the
  summary's, and a field name can be wrong.
- **[T]** a third-party article or a community project's README.
- **[O]** stated by the operator who asked for the integration, not found
  elsewhere.

Nothing below is **verified against the live API**: no call was made, and no
key existed. The last section lists what the first real run has to settle.
`:trace` exists so that it can: the tools keep every operation's trace beside
what it made.

## Where it is

| | | source |
|---|---|---|
| Documentation | `https://docs.atlas.worldlabs.ai/` (Quickstart, API reference, Billing, Best practices, Skills and plugins, "Posed images to splats") | [S] |
| API host | `https://api.atlas.worldlabs.ai`, paths under `/api/v2` | [S] the health-check page |
| Health | `GET /api/v2/health`, no key: "for checking that the host is reachable before debugging credentials" | [S] |
| Other hosts seen | `api.atlas-beta.worldlabs.ai/api/v2` (the beta's) and `atlas.worldlabs.ai/api/v2` (a community gateway's) | [T] |
| Not this | `api.worldlabs.ai/marble/v1` is the Marble "World API", another product with another price list | [S] |

The client's default host is the health-check page's; `WORLDLABS_ATLAS_BASE_URL`
names another.

## Authentication

- Header `WLT-Api-Key: <key>`. [S] the Atlas reference; [T] agrees. Marble's
  API uses the same header. [S]
- A key belongs to a *project*; usage is billed to the account that owns the
  key's project. [S] Billing page
- Scopes a key may carry: `tasks.create`, `operations.read`, `assets.create`,
  `assets.read`. [T] a ComfyUI node's README
- "Keep API keys server-side and scope one key to one deployed service." [S]
  Best practices
- **The environment variable's name in the documentation is not known.** The
  package reads `WORLDLABS_API_KEY` [O].
- The MCP server needs no key: it signs the user in. [S] Skills and plugins

## Tasks

Each is `POST /api/v2/tasks:<name>` and answers with an *operation*, not a
result. [S] API reference lists `atlasGenerate`, `images2PosedRGBD`,
`posedImages2Splats`, `splats2Mesh`; [T][O] add `atlasChisel` and
`atlasTextToImage`, six in all.

| task | takes | gives | source |
|---|---|---|---|
| `images2PosedRGBD` | pictures | "the same pictures with an estimated camera and depth" | [T] |
| `posedImages2Splats` | two or more **ordered** frames (8–16 for a room), each an image, its camera (intrinsics and pose) and a **linear-depth EXR**; all images the same size. `refine: false` asks for a draft | one `.spz` Gaussian splat; a refined run returned `refinedSplats_2000000.spz` | [T] |
| `splats2Mesh` | a `.spz` | a GLB mesh; options for a region, a face count, and textures / vertex colours / untextured | [T] |
| `atlasGenerate` | posed views as context, the cameras wanted, a prompt: `contextFrames[]`, `targetCameras[]`, `prompt`. "Submit the full ordered camera path in one request" | pictures (and depth) at those cameras | [T] |
| `atlasChisel` | an image to edit, by its name in the apps | an image | [O] name only |
| `atlasTextToImage` | words | an image | [O] name only |

- `posedImages2Splats` carried a *beta* label, and its page says limits "may
  change during beta". [T]
- Target sizes `atlasGenerate` accepts: 1280×720, 960×720, 528×704,
  720×1280. [T] Nothing larger: 720p is the ceiling [O].
- A video is frames: the official flythrough skill needs FFmpeg "to assemble
  the frames into an MP4". [S] Skills and plugins
- Durations: a refined splat 10–20 minutes [T], 15–25 [O].

**Not known for any task:** the JSON names of its request fields beyond
`refine`, `posedFrames`, `contextFrames`, `targetCameras` and `prompt`, which
are third-party; its response's shape; how an uploaded file is named in a
request; limits on count and size.

## Operations

[S] API reference, unless marked.

| | |
|---|---|
| list | `GET /api/v2/operations` |
| get | `GET /api/v2/operations/{operation}` |
| wait | `POST /api/v2/operations/{operation}:wait`: holds the connection up to a server-side cap [T] |
| cancel | `POST /api/v2/operations/{operation}:cancel` |
| trace | `GET /api/v2/operations/{operation}:trace`: "the request you sent beside its result" [T] |
| webhooks | a webhook URL can be set on any task [T]; the reference lists webhook-delivery endpoints |

- "A timeout stops local waiting; it does not cancel the server task." [T]
- Expect HTTP 429; task and concurrency limits were not final. [T]
- "Do not stack several uncontrolled retries inside one product action";
  "expose a job state to your application so users can leave and return". [S]
  Best practices

**Not known:** the operation's fields. Marble's operations have
`operation_id`, `done`, `error`, `metadata`, `response` and a cost set on
success [S]; the path style of Atlas (`{operation}`, `:wait`) is Google's,
whose operations have `name`, `done`, `metadata`, `response`, `error`. The
client reads either.

## Assets

Files go in and come out through `/api/v2/assets`: **create upload URL →
(upload the bytes) → complete upload → create read URL**; `GET
/api/v2/assets/{asset}` reads one. [S] the reference's list of endpoints; [O]
the order.

**Not known:** the three endpoints' exact paths and bodies, what an asset's
id looks like, accepted types, size limits, how long an asset or a URL lives.

## Cameras

- "Atlas outputs use OpenGL/Three.js right-up-back (rub) unless the live
  schema says otherwise. Camera-bearing schemas state their coordinate
  convention." [S] Best practices
- "Convert once at your system boundary and test with a known camera rather
  than sprinkling axis flips through rendering code." [S]
- A camera path is geometry, not words: the cameras themselves, in order. [T]
- For geometry, "overlapping viewpoints that include translation, not only
  rotation"; wide or medium views rather than close-ups; people, vehicles and
  water that move reduce consistency. [S]

**Not known:** the JSON of a camera (intrinsics as `fx fy cx cy` or a matrix;
camera-to-world or world-to-camera; row or column order), units and scale of a
reconstructed scene.

## Formats

| | | source |
|---|---|---|
| Splat | `.spz` | [T] |
| `.ply` | a community node builds a *point cloud* PLY from depth maps itself: no evidence the API returns a PLY splat | [T] |
| Mesh | GLB | [T] |
| Depth | linear-depth EXR | [T] |
| Resolution | 720p at most | [T][O] |

## Money

- **1,000 credits per US dollar**; purchased credits do not expire; "may
  change during beta". Balances, top-ups and monthly spend limits are in the
  Developer Platform's settings. [S] Billing
- A refined `posedImages2Splats` run: **5,000 credits ($5)**; a draft
  (`refine: false`): **500 credits ($0.50)**; a failed run is free. These are
  the splat step only: "generating the input views is separate". [T], and [O]
  agrees
- Prompt enhancement 20 credits, an image edit 125 credits: prices of actions
  in the apps, not known to be an API task's. [S]
- "World Labs has no public price list for API tasks"; the rate card is shown
  to a signed-in account. [T]
- Marble's API sells credits at 1,250 a dollar. Its prices are not Atlas's. [S]

**Not known:** what `images2PosedRGBD`, `splats2Mesh`, `atlasGenerate`,
`atlasChisel` and `atlasTextToImage` cost; whether an operation reports what
it was charged, and in which field; whether a cancelled run is charged.

## Licence

From reports of World Labs' Terms of Service. [T]

- **Free accounts:** World Labs keeps the rights in outputs and grants "a
  revocable, non-exclusive, royalty-free, worldwide license … solely for
  personal, Non-Commercial Use". One report extends this to a Standard tier,
  and says it holds "even after an account upgrade".
- **Paid API access** (and Pro or higher subscriptions) permits commercial
  use, "subject to the agreement".
- What is uploaded may be used by World Labs, training included; paid users
  can opt out of some training uses, from then on.

The terms themselves were not read. The plan a key belongs to cannot be asked
of the API as far as is known, so the operator states it, once, in the
library.

## Tooling World Labs ships

[S] Skills and plugins.

- A CLI, `@worldlabsai/cli`; `worldlabs skills install` installs agent skills
  (`atlas-splats`, `atlas-flythrough`, `worldlabs-cli`, `atlas-blender`). They
  pose the images and generate a few views to look at *before* the long step.
- The Blender skill needs **Blender 5.3 or newer** and the Atlas extension.
  `@av/blender` supports 4.2–4.x and 5.2.x: the extension is not used here,
  and a set reaches Blender as a GLB.
- An MCP server that runs the same tasks. The studio does not use it
  (ADR-0007's reasons).

## The company

World Labs was acquired by AMD, closing 2026-11-16 [O]; one article's address
reads "amds-world-model-arrives" [T]. Nothing else was found. Hosts, prices
and terms may move.

## What the first real run has to settle

In the order a smoke test meets them. The request shapes live in one file,
`packages/worldlabs-atlas/src/wire.ts`; the readers of answers accept several
spellings and say what they could not find.

1. The host and `GET /api/v2/health`.
2. The key's header and its environment variable's documented name.
3. The three asset endpoints: paths, bodies, the upload's method and headers.
4. How a request names an uploaded file (`wireAsset`).
5. `images2PosedRGBD`: request, and the shape of a posed frame.
6. `posedImages2Splats`: that the posed frames go back as they came; `refine`.
7. The operation's fields: id, done, error, result, progress, charge.
8. `:wait`'s body and cap; `:cancel`; `:trace`'s content.
9. `splats2Mesh`: request, options, the GLB's scale and up axis.
10. `atlasGenerate`: context frames, target cameras, the camera's JSON and
    convention, the frames' form.
11. Every price but the splat's, and that a failed or cancelled run is free.
12. Rate limits, the error body, `Retry-After`.
13. Webhooks: the field, the payload, the signature. Not used yet.
14. How long assets live: whether a refined pass can reuse a draft's posed
    frames days later.
15. The terms of the plan in use.

## Sources

Official pages, known through search summaries only:
`docs.atlas.worldlabs.ai/quickstart`, `/api-reference`,
`/api-reference/health-check`, `/billing`, `/best-practices`,
`/skills-and-plugins`; `docs.worldlabs.ai/api` and `/api/pricing` (Marble).

Third parties: vr.org, "World Labs Put Six Atlas Endpoints Behind an API Key"
(2026-11-16); radiancefields.com, "World Labs Opens Atlas World Model to
Everyone"; stork.ai, "World Labs Atlas: Pricing & Alternatives"; the READMEs of
`szprivate/ComfyUI-WorldLabsAtlas` and `Shamnick/atlas-pool`; pull requests of
`worldlabsai/skills`; blendedboris.com on the terms; dev.to, a Chisel
walkthrough.
