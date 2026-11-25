# World Labs Atlas API: what the documentation says

Notes for `@av/worldlabs-atlas`
([ADR-0057](../adr/0057-atlas-builds-location-sets-behind-world-capabilities.md)),
taken from the Atlas Developer API documentation as it stood on
**2026-11-25**: every page listed in `https://docs.atlas.worldlabs.ai/llms.txt`,
read as Markdown (append `.md` to a page's address), with the OpenAPI schema
each reference page carries. The reference says of itself that it "is
generated from the same Atlas schemas as the service".

## How far this goes

- **Read in the documentation**: everything below, unless marked otherwise.
- **Not run against the live API**: anything. No key existed and no call was
  made, paid or free. A documented shape is a strong claim, not a tested one;
  [what a first real run has to settle](#what-a-first-real-run-has-to-settle)
  is at the end.
- **An earlier version of these notes** was written without the
  documentation, from search summaries and third parties. Most request and
  response shapes guessed then were wrong; the client, its fake and the tools
  were rewritten from the pages. What that first reading got wrong is listed
  in [the last section](#what-the-first-reading-had-wrong), because the same
  mistakes are easy to make again from an article or an older API.

> "Use the endpoint names and schemas in this documentation, not examples for
> the legacy Marble or World APIs." — Quickstart

## Where it is

| | |
|---|---|
| API root | `https://api.atlas.worldlabs.ai/api/v2` |
| Health | `GET /health`, no key: "separates connectivity issues from authentication or request-shape problems" |
| Platform | `https://atlas.worldlabs.ai` (Developers → API keys; Settings → Developer Platform, Usage, Billing, General) |
| Status | `https://status.worldlabs.ai/` |
| MCP server | `https://api.atlas.worldlabs.ai/mcp`, OAuth sign-in, no key; same tasks, same prices |

The documentation's own environment variables are **`WLT_API_KEY`** and
**`WLT_API_BASE_URL`** (the root above, version included). Its CLI
(`@worldlabsai/cli`, Node 22+) and its TypeScript client
(`@worldlabsai/client`) read them, and so does this package.

## Authentication

- Header `WLT-Api-Key: <key>` on every protected request; never in a query.
- A key is issued inside one **project**; the server derives account and
  project from it. Assets, operations, usage and spend limits are the
  project's. A key cannot read another project's.
- Scopes: `tasks.create`, `operations.read`, `operations.cancel`,
  `assets.create`, `assets.read`, `assets.delete`, `projects.read`. A task
  worker needs the first, second, fourth and fifth; `operations.cancel` only
  to cancel. A valid key without the scope gets `403`.
- The secret is shown once. The platform keeps its last four characters.

## Assets

A file in the project: `asset_<hex>`. Bytes are never public; they go in and
out through short-lived signed URLs.

States: `CREATED` → (`:createUploadUrl`) `UPLOADING` → (`:completeUpload`)
`READY`; `DELETED`. Only a `READY` asset can be read or used. An unfinished
one is deleted two hours after it was created or last given an upload URL.

**Adding one** always starts with `POST /assets`, with one of:

| the file is | send in `asset` | `READY` |
|---|---|---|
| at a public HTTPS URL | `url` | in the create response |
| in memory, under 10 MiB | `base64` | in the create response |
| on disk, up to 1 GiB | only a `displayName` | after `:completeUpload` |
| several files for one image | `type` and `parts` | after `:completeUpload` |

**Uploading a file** is four requests, three with the key:

1. `POST /assets` `{ "asset": { "displayName": "room.png" } }` → `id`
2. `POST /assets/{id}:createUploadUrl` `{ "contentType": "image/png", "contentLength": 248901 }`
   → `{ uploadUrl, method, headers, expiresAt }`. Both must match the file.
3. `method` to `uploadUrl` with every returned header, **without** the key.
   The URL lasts 30 minutes and takes one successful upload.
4. `POST /assets/{id}:completeUpload` `{}` → the `READY` asset (`mimeType`,
   `sizeBytes` as a string, `width`, `height`). Repeating it is safe.

**Reading one**: `POST /assets/{id}:createReadUrl` → `{ readUrl, expiresAt }`,
good for 15 minutes, fetched without the key, and a secret while it lasts.
(`POST /assets:createReadPrefix` signs every asset of the project for an
hour.)

**In a task**, an asset is a `TaskAsset`: `{ "assetId": … }`, or `{ "url": … }`
for a public file (fetched and stored again as a new asset), or `{ "base64":
… }`. A task's **result names each file by `assetId` and `url` together**:
the `url` works for 24 hours, the `assetId` until the asset is deleted. "To
feed an output into the next task, send its `assetId`, not its `url`"; the
pair is accepted as input and the id is what counts.

Output assets "are kept in the project's library until you delete them",
unless the account, or the request (`purgeContentOnOperationCompletion`),
says to purge them an hour after the operation.

## Operations

Every task submission returns one. `HTTP 201`.

```json
{
  "id": "op_01jexample000000000000000000",
  "name": "accounts/acct_example/projects/project_example/operations/op_01jexample000000000000000000",
  "ownerId": "acct_example",
  "metadata": { "task": "atlasGenerate" },
  "done": false,
  "response": null,
  "error": null,
  "createdAtSecs": 1789412264,
  "expiresAtSecs": 1789415864
}
```

- **`done` is the only terminal signal.** `done: true` with `response`
  succeeded; with `error` failed. `metadata` "can report a phase or progress
  percentage, but clients must not infer completion from those fields".
- **An operation does not say what it cost.** No field of it does.
- `error` is `{ code, message, details }`: `code` a `google.rpc.Code`
  number, broad; the reason in a `google.rpc.ErrorInfo` entry of `details`:
  `EXECUTION_FAILED` (13), `EXECUTION_TIMEOUT` (4), `THROTTLED` (8),
  `CONTENT_POLICY` (3). "Branch on the string code or reason, not the
  message."
- `expiresAtSecs` is the task's deadline, not a URL's.

| | |
|---|---|
| get | `GET /operations/{id}` |
| wait | `POST /operations/{id}:wait` `{ "timeoutSecs": 30 }`: capped at 30 server-side, best-effort, and "the response may still have `done: false`" |
| list | `GET /operations?task=&status=RUNNING\|SUCCEEDED\|FAILED&createdAfter=&createdBefore=&pageSize=&pageToken=` → `{ operations, nextPageToken }`, newest first, **without** `response`. `FAILED` includes cancelled and expired |
| trace | `GET /operations/{id}:trace` → `{ operationId, taskName, taskVersion, request, response, error }`: "the request as you sent it beside the operation's `response` and `error`" |
| cancel | `POST /operations/{id}:cancel` `{ "requestId": …, "reason": … }`: asynchronous and best-effort; reuse `requestId` (36 characters at most) when retrying; "work that already finished may retain its real success or failure result" |

- **Submit once, by name.** "Send a stable `Idempotency-Key` for each logical
  task. If a timeout or broken connection makes the response uncertain,
  retry the same validated body with the same key." A successful replay
  returns the original operation; the key with another body is `409`. "Do
  not create a new idempotency key for a transport retry; that can start
  duplicate work."
- A submission with `?wait=true` holds its request open, and the load
  balancer closes any request after 60 seconds (`504`): long work is
  submitted without it. `?wait=true` and `webhookUrl` exclude each other.
- "A brief `404` can be retried" on an operation just accepted; "a
  persistent `404` is an API issue: keep the operation ID for support rather
  than submitting the same work again".
- Poll "using capped exponential backoff and jitter".
- **Retention**: an operation, its trace and its response for **30 days**.
- "A timeout stops local waiting; it does not cancel the server task."

## Errors and limits

| status | meaning | do |
|---|---|---|
| 400 | invalid argument or transition | correct it |
| 401 | missing, unknown, expired or revoked key | replace it |
| 402 | out of credits, or a spend limit (`CREDITS_UNAVAILABLE`, `SPEND_LIMIT_EXCEEDED`, `PAID_SEAT_REQUIRED`) | add credits or raise the limit, then resubmit with the same key |
| 403 | missing scope, project mismatch, region not set (`REGION_NOT_DECLARED`), `CONTENT_POLICY` | fix it |
| 404 | resource absent, unknown task | check the id |
| 409 | idempotency key reused with another body | |
| 422 | the JSON does not match the schema | correct it |
| 429 | a limit (`RATE_LIMIT_EXCEEDED`, `CONCURRENCY_LIMIT_EXCEEDED`, `CONCURRENCY_CONFLICT`, `TASK_UNAVAILABLE`) | honour `Retry-After` |
| 451 | region not supported | do not retry |
| 500 | unexpected | "retry safely" |
| 503 | no capacity | backoff; may carry `Retry-After` |
| 504 | the 60-second gateway limit | retry with the same key, then poll |

- A rejected submission carries a stable top-level `code`; validation errors
  a `detail` array.
- **Request schemas refuse unknown fields** (`additionalProperties: false`):
  "supplying extra camera fields is rejected with HTTP 422".
- The rate card of limits is "to be announced". Each task type also caps how
  many of its tasks may be open at once, per account and service-wide; a
  submission over the cap "is refused rather than queued". Limits are shared
  between the web app, the API and the playground. Other mutations: 10 a
  second per account.
- "An admission-limit 429 means the task was not accepted."

## Cameras

```json
{
  "extrinsics": { "position": [0, 1.6, 4], "quaternion": [0, 0, 0, 1], "coordinateSystem": "rub" },
  "intrinsics": { "fx": 1200, "fy": 1200, "cx": 960, "cy": 540, "width": 1920, "height": 1080 }
}
```

- A pinhole. **Camera-to-world**, a world-space `position` and an **XYZW**
  unit `quaternion`. No matrices, no Euler angles, no distortion.
- `coordinateSystem`: `"rub"` (right, up, back: looks along −Z; OpenGL,
  Three.js, Blender's camera axes), the default and what outputs use; or
  `"rdf"` (right, down, forward: looks along +Z; OpenCV). "Do not change only
  the string to convert a pose."
- The world is **Y-up**. "Blender is Z-up while Atlas's RUB world is Y-up."
  "In a Y-up world, turning a RUB camera to its right is a negative rotation
  about +Y. A camera with no rotation that turns 30° to the right has the
  quaternion `[0, -0.2588, 0, 0.9659]`." (The package's tests hold its
  camera maths to this example.)
- Intrinsics are in pixels of the grid they name; pixel `(0, 0)` is top-left.
- **Scale**: "Camera positions establish the rig's scale." For estimated
  cameras, "metric scale is predicted, so physical distances are
  approximate". Depth is distance along the viewing axis, in the same unit.
- Returned depth is a linear-depth **EXR**, half-float, `NaN` where there is
  no reliable geometry, beside a confidence PNG.

## The tasks

`POST /tasks:<name>`. Common to every body: `webhookUrl`,
`purgeContentOnOperationCompletion`.

### `images2PosedRGBD` — pictures → cameras and depth

```json
{ "frames": [{ "imageAsset": { "assetId": "asset_room_01" } }], "targetResolution": [1280, 720] }
```

- `frames`: **1 to 64**, in a stable order, each an `imageAsset` and nothing
  else: "a frame that carries a camera, a depth buffer or a mask is rejected
  rather than quietly ignored".
- `targetResolution`: one of `[1280, 720]`, `[720, 1280]`, `[960, 720]`,
  `[528, 704]`; the result is scaled to cover it and center-cropped, "so an
  aspect that differs from the frames' costs field of view". Without it,
  multi-view captures with camera translation come back on the closest of
  those grids, but "single images and captures without camera translation
  retain the reconstruction backend's native grid", and the returned image
  can be on another grid than its depth. **Set it**: "so the image, its
  depth, and every later view share one grid".
- `refinePoses` (default false): bundle-adjust the cameras, for two or more
  frames whose "output feeds a stage that compares views against each
  other". A refinement that does not hold is discarded, not an error;
  `poseRefinementAccepted` says which.
- `canonicalizeToFirstFrame`, `base64Outputs`.
- Result: `{ frames: [{ imageAsset, camera, depth: { depthAsset,
  confidenceAsset }, centroidWorld }], poseRefinementAccepted }`, one per
  picture, in order. `centroidWorld` is the "ground-plane pivot": the middle
  of what the frame sees, dropped to y 0.
- One image goes the single-view path. Pictures "of one real place" go
  together, "so their cameras share one world".

### `atlasGenerate` — posed frames and cameras → views

```json
{ "contextFrames": [{ "imageAsset": {}, "camera": {}, "depth": { "depthAsset": {} } }],
  "targetCameras": [{ "extrinsics": {}, "intrinsics": {} }], "returnDepth": true }
```

- `contextFrames`: one or more, each **image, depth and camera, all
  required**, all of one size (which may differ from the targets').
- `targetCameras`: one or more, all of one size: **1280×720, 960×720,
  528×704 or 720×1280**. One frame comes back per camera, in order. Nothing
  larger exists.
- `prompt` describes "the scene's content and appearance", not an edit and
  not a camera move. `enhancePrompt` defaults to true; the result's
  `promptUsed` can be passed back with `enhancePrompt: false`, which "skips
  recaptioning the context images and reduces generation latency".
- `returnDepth` (default false): each frame then carries depth and can be
  context or a splat's frame. It is refused (`422`) when every camera shares
  one centre. Depth is made in the generation call for at most 11 context
  frames, 32 targets and not 720×1280; beyond that in a separate step, which
  needs matching aspect ratios and centred principal points.
- `modelParameters`: `seed` (default 42), `numSteps`.
- Result: `{ frames: [{ imageAsset, camera, depth? }], promptUsed, requestId }`.
  **Frames are JPEG.**
- **A path goes in one request.** "Do not split a continuous trajectory into
  independent frame requests or small batches … Separate requests do not
  share generated sequence context." About 1,500 target cameras with 8
  context frames; more is a `422`.
- Timings given: 7 views in 23 seconds; 192 frames in 109 seconds.

### `posedImages2Splats` — frames → a Gaussian splat

```json
{ "posedFrames": [{ "imageAsset": {}, "depth": { "depthAsset": {} }, "camera": {} }], "refine": false }
```

- `posedFrames`: **2 to 512 refined, 2 to 32 for a draft**, each image,
  camera and depth. "Every camera grid must be one of 1280x720, 720x1280,
  960x720, or 528x704, … and all frames must declare the same grid."
- `refine`: true by default; `false` is a **draft**, which "skips the
  iterative view-generation and refinement loop".
- `prompt`, `enhancePrompt`, `regionOfInterest`.
- Result: refined `{ "refinedSplats": { "2000000": { assetId, url } } }`,
  keyed by splat count; draft `{ "refinedSplats": {}, "draftSplat": {
  assetId, url } }`. An **SPZ** file, in the world of the cameras submitted.
- **Price** (the only one the documentation gives): "Refined (the default):
  5,000 credits ($5). Draft, with `refine: false`: 500 credits ($0.50).
  **Failed runs are free.**"
- **Time**: draft "about 30 seconds in benchmarks"; refined, 2 to 32 views,
  "about 15 to 21 minutes"; 33 to 512, "up to 30 minutes"; plus waiting for
  capacity.
- "If waiting times out, wait again. Do not submit the request again while
  the operation is running; a second run is a second charge."
- "Refinement does not guarantee that inconsistent depths or conflicting
  object placements will be fixed."

> **The documentation disagrees with itself here.** The task guide documents
> `refine` and `draftSplat`; the reference's schema for this task lists
> neither, and refuses unknown fields. The guide is followed. If a draft
> comes back `422`, this is the first place to look.

### `splats2Mesh` — a splat → a GLB

```json
{ "splatAsset": { "assetId": "asset_…" }, "textureMode": "image_texture", "textureSize": 4096 }
```

- `splatAsset` (required): the `.spz`.
- `textureMode`: `image_texture` (default), `vertex_color`, `none`.
  `textureSize` 1–8192, default 4096. `targetFaces`: decimate to at most
  that many.
- `cameras`: a strategy — `auto_anchors` (default: viewpoints in the scene's
  free space), `manual_anchors` (`anchors`), `exterior_sphere` (an object,
  from outside) — or up to 512 cameras. "Geometry no camera sees is not
  meshed."
- `orientedBoundingBox`, `colliderBoxes`, `advancedOptions`.
- Result: `{ mesh, colliderBoxes, anchorPositions, metadata }`. Three.js
  coordinates: +X right, +Y up, −Z forward.
- No price and no time are given.

### `atlasTextToImage`, `atlasChisel`

- `atlasTextToImage`: `{ prompt, aspectRatio, enhancePrompt, seed, numSteps,
  numSamples, returnDepth }` → `{ frames, promptUsed, promptsUsed,
  aspectRatio }`. With `returnDepth`, each picture comes with a camera and
  depth: a place from words, ready to be context.
- `atlasChisel`: depth-guided generation, restyling and masked edits, at
  1280×720, from `targetFrames` (up to 1,440), optional `contextFrames`, a
  required `prompt`. Not used here; reachable with the client's `run`.

## The order of work

From *Build a scene from images*, *Make splats* and *Make a video*:

1. **Pose** the pictures, with `targetResolution` set.
2. **Generate views round the main part of the scene**: one `atlasGenerate`
   request, the posed frames as context, **6 to 12** new cameras,
   `returnDepth: true`. Cameras spread round it, each looking at it, at about
   the original camera's height, each in its own position, "in space the
   posed images show as empty". One request, so that Atlas "decides the
   unseen parts of the scene once, for all of them".
   "From a single image, a camera can turn about half the field of view, or
   move about a third of the typical depth, and still show mostly what the
   image showed. Beyond that, Atlas invents what the view shows."
3. **Check the views.** "Remove a view that disagrees with the others." "When
   someone else asked for the result, show them the views now."
4. Then **splats**, once: posed frames and kept views, **8 to 16** for a
   room. "Areas no view shows come out blurry or invented." "An object with
   a different shape or place in two views becomes a doubled, ghosted
   object."
   Or **a video**: one camera per frame, the whole path in one request,
   `returnDepth: false`, frames joined with FFmpeg.

Inputs (*Best practices*, *Splat best practices*): sharp; wide or medium;
steady exposure and light; overlapping, about half shared content between
neighbours; translation, not only rotation; nothing that moves. "Atlas models
do especially well on worlds … They are not yet as strong on humans or
dynamic objects." Hard for splats: large open spaces, sky, foliage, plain
walls, faces, thin structures, windows.

## Money

- **1,000 credits to the US dollar.** Purchased credits do not expire.
- "The task rate card can change. Use the current rate card shown in the
  platform when estimating task costs **rather than embedding model prices
  in client code**." Only the splat's price is on a documentation page.
- Usage is billed to the account that owns the key's project; the Usage
  page shows it per day, task, project and key, a few minutes late.
- Monthly spend limits, per account or per project: at 100% new tasks are
  refused (`402`), running ones finish. "Spend limits are guardrails, not
  exact real-time accounting boundaries."

## Licence

Terms of Service, dated 11.10.26 (`/terms-of-service`).

- **Eligible Paid Access** (9.23): "an active Pro or higher Subscription
  Service; paid API access; or paid access … that World Labs designates as
  eligible". 2.3(b): "Customer owns Outputs generated through Eligible Paid
  Access" and may use them "for any purpose, including Commercial Purposes",
  for API access subject to 1.12.
- **Low-Tier Access** (9.30): "a free or Standard tier, including a trial,
  promotional, or other service arrangement …, and any other use of the
  Services that is not Eligible Paid Access". 2.3(a): "World Labs retains
  all rights in and to any Output generated through Low-Tier Access" and
  licenses it "solely for personal, Non-Commercial Use".
- 2.3(c): rights "are determined by the access used to generate it at the
  time of Output generation": a free output stays so after an upgrade.
- 2.6: a licence to use Customer Content "for World Labs' internal business
  purposes, including … developing and training AI Models". Paid access can
  opt out account-wide (Settings → General, "Use my data to improve
  models"), prospectively; for Low-Tier Access it is "irrevocable and not
  subject to opt-out".
- 2.7: do not misrepresent how an Output was made; identify World Labs on
  reasonable request; leave provenance data in place. 1.10(d): no use of
  Outputs to train or build a competing model.

Whether usage on promotional or sign-up credits counts as "paid API access"
is not something the API says about a key: the operator states the plan.

## What World Labs ships beside the API

- A CLI, `@worldlabsai/cli` (`worldlabs tasks run`, `operations wait`,
  `operations download`, `assets upload`), and agent skills
  (`atlas-flythrough`, `atlas-splats`, `atlas-blender`, `worldlabs-cli`).
- A TypeScript client, `@worldlabsai/client`.
- **Blender**: 5.3 imports `.spz` and `.ply` splats natively; an Atlas
  extension adds posed RGBD images. `@av/blender` supports 4.2–4.x and
  5.2.x, so a set reaches it as a GLB.
- World Labs' parent company is AMD (Privacy Policy).

## What a first real run has to settle

In the order a smoke test meets it.

1. `GET /health` on the default root.
2. That a key with the four scopes is enough.
3. The four upload requests, with a real PNG and a real upload URL's headers.
4. `images2PosedRGBD` with `targetResolution`: the frames' shape, and that
   `centroidWorld` is there (the orbit uses it; without it the tool says it
   is guessing).
5. That the reduced frames (`imageAsset`, `camera`, `depth`, by `assetId`)
   are accepted by `atlasGenerate` and `posedImages2Splats`.
6. **`refine: false`** and `draftSplat`: the guide and the reference
   disagree.
7. `atlasGenerate` with the package's cameras: that an orbit made here
   looks at what it is meant to (the quaternion convention is tested against
   the documentation's example, not against a render).
8. `splats2Mesh`: the GLB's size, and whether it wants a `setScale`.
9. The idempotent replay: the same key and body returning the same operation.
10. What the rate card says of posing, views and a mesh; whether a render
    is metered per view, as `atlasGenerate.perView` assumes.
11. `:trace`, `:wait`, `:cancel` as documented.

When one disagrees with what is here: correct `packages/worldlabs-atlas/src/wire.ts`
and its test, and this file. When they all agree: set `WIRE.verifiedLive`.

## What the first reading had wrong

Written before the documentation could be opened, from search summaries and
third-party articles. Kept as a warning about those sources.

| guessed | the documentation |
|---|---|
| key in `WORLDLABS_API_KEY` | `WLT_API_KEY`, and the root in `WLT_API_BASE_URL` |
| three upload requests, `assets:createUploadUrl` first | four: `POST /assets`, then `/{id}:createUploadUrl` with `contentType` and `contentLength` |
| `images2PosedRGBD { images: [{ assetId }] }` | `{ frames: [{ imageAsset: { assetId } }], targetResolution }` |
| a camera as a 4×4 `cameraToWorld` matrix with `convention` | `extrinsics { position, quaternion, coordinateSystem }` and `intrinsics` |
| posed frames passed on untouched | a frame as returned has `centroidWorld`, which the next task refuses |
| `splats2Mesh { splat, textureMode: "textured" }` | `{ splatAsset, textureMode: "image_texture" \| "vertex_color" \| "none" }` |
| a splat found by its file name | `draftSplat`, or `refinedSplats` keyed by splat count |
| an operation might report credits charged | it reports no cost at all |
| a submission must never be retried | it is retried safely, with the same `Idempotency-Key` |
| `:wait` with `timeoutSeconds`, cap unknown | `timeoutSecs`, capped at 30 |
| failed runs free "by a third party's word" | stated on the splat's page, for the splat |
| limits of 32 pictures, 48 views | 64 pictures; about 1,500 target cameras |
| a 720p ceiling "to be confirmed" | four target sizes, none larger |
