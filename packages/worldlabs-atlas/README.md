# @av/worldlabs-atlas

A client for the [World Labs Atlas](https://docs.atlas.worldlabs.ai/)
Developer API: pictures of a place become estimated cameras and depth, then a
Gaussian splat, then a polygon mesh; and the place can be seen again from
cameras it is given.

It knows nothing of films or episodes. It is useful to anything that wants a
3D place from photographs and has an Atlas key.

> **Written from the documentation, not yet run against the service.** Every
> request and answer follows the Atlas documentation as read on 2026-11-25
> (the task guides and the API reference, which is generated from the
> service's schemas). No call has been made. `WIRE.verifiedLive` in
> `src/wire.ts` is `null` until a real run has confirmed the shapes; what the
> documentation says, and what a first run has to settle, is in
> `docs/notes/worldlabs-atlas-api.md` in the repository. The first real call
> should be a draft.

World Labs ships its own CLI (`@worldlabsai/cli`) and TypeScript client
(`@worldlabsai/client`). This package exists beside them because it is built
to be accounted for: every part that touches the network, the clock or a
sleep is injected, each operation leaves a provenance record, each task has a
price that says where it comes from, and a fake Atlas runs the whole client
without a network.

## What it does

| | Atlas task | here |
|---|---|---|
| pictures → frames with a camera and depth | `images2PosedRGBD` | `client.poseImages` |
| frames + cameras → views, with depth when asked | `atlasGenerate` | `client.generateViews` |
| frames → a splat (`.spz`), draft or refined | `posedImages2Splats` | `client.splatsFromPosedImages` |
| a splat → a mesh (GLB) | `splats2Mesh` | `client.meshFromSplats` |
| words → a picture | `atlasTextToImage` | `client.textToImage` |
| depth-guided generation, masked edits | `atlasChisel` | `client.run("atlasChisel", body)` |

Around them: uploads (`uploadFile`), operations (`getOperation`,
`waitUntilDone`, `waitOperation`, `cancelOperation`, `traceOperation`,
`listOperations`), downloads (`download`), cameras (`orbit`, `push`, `placed`,
`lookAt`, `matrixOf`, `quaternionOf`), a price list (`estimate`) and a record
of how each file was made (`provenanceOf`).

```ts
import { createAtlasClient, posedFrame, readPosedFrames, readSplat, provenanceOf } from "@av/worldlabs-atlas";

const atlas = createAtlasClient();               // WLT_API_KEY, WLT_API_BASE_URL
const images = [];
for (const file of files) images.push(await atlas.uploadFile(file));

// On one grid from the start: what follows needs it.
const posed = await atlas.poseImages({ images, targetResolution: [1280, 720] });
// A frame goes on as exactly what the next task takes. As it came, it would be refused.
const frames = readPosedFrames(posed.operation.response).map((frame) => posedFrame(frame)!);

const request = { posedFrames: frames, refine: false };          // a draft: a tenth of the price
const run = await atlas.splatsFromPosedImages(request, {
  idempotencyKey: "yard-a-draft",                                // the same work, the same name, on every attempt
  onSubmitted: (operation) => remember(operation.id),            // before any waiting
});
const bytes = await atlas.download(readSplat(run.operation.response).asset);
const record = provenanceOf(run, request);                       // keep it beside the file
```

## Three rules

- **One logical task, one `Idempotency-Key`.** A submission whose answer is
  lost may be a job accepted and charged. Asked again with the same body and
  the same key, Atlas returns the first operation and starts nothing; the
  client does that by itself on a lost answer, a `504` or a `429`, and a
  caller that names the key can do it from another process, after a crash. A
  new key for the same work is a second charge.
- **A wait that ends leaves the job running.** A refined splat takes fifteen
  to thirty minutes. `AtlasTimeoutError` and `AtlasCancelledError` name the
  operation; `client.resume(task, operationId)` takes it up again, from any
  process. Giving up is not cancelling: `cancelOperation` is its own
  request, and best-effort.
- **Nothing is chosen silently.** No other host, quality or task is tried
  when one fails, and a price nobody published is `priced: false`, not a
  guess.

## What Atlas is strict about

- **Requests refuse fields they do not know** (HTTP 422). A frame that
  posing returns carries `centroidWorld`, which a splat's frame may not:
  `posedFrame(frame)` keeps exactly the image, the camera and the depth, each
  asset by its id.
- **A result names a file by `assetId` and `url` together.** The url expires
  in a day; the id lasts until the asset is deleted. `download` reads through
  the id; a request names the id alone.
- **`done` is the only end of an operation.** Its metadata may report a phase
  or a percentage: for showing, never for deciding.
- **Four sizes, none above 720p**: 1280×720, 960×720, 528×704, 720×1280, for
  depth grids and for views. Every frame of a splat is on one of them, the
  same one.
- **A camera is a position and an XYZW quaternion**, camera-to-world, in a
  Y-up world, looking along its own −Z (`"rub"`). `wireCamera` and
  `readCamera` convert to and from this package's matrix; `"rdf"` is read.

## Configuration

The provider's own names: its CLI and its client read the same two.

| variable | |
|---|---|
| `WLT_API_KEY` | a project-scoped key, sent as `WLT-Api-Key`. Required. Scopes: `tasks.create`, `operations.read`, `assets.create`, `assets.read`; `operations.cancel` to cancel |
| `WLT_API_BASE_URL` | another API root than `https://api.atlas.worldlabs.ai/api/v2` |

## Money

1,000 credits to the dollar. The documentation prices one task: a draft
splat is 500 credits, a refined one 5,000, and a failed run is free. For the
rest it says to read the account's rate card rather than embed prices in
code, so `estimate(task, request, operator)` takes them from whoever holds
the account and says `unknown` otherwise.

**An operation does not say what it was charged.** A run's cost is its price
here, or the account's Usage page.

## Command line

```bash
npm run cli --workspace @av/worldlabs-atlas -- health            # no key, no charge
npm run cli --workspace @av/worldlabs-atlas -- prices
npm run cli --workspace @av/worldlabs-atlas -- operations
npm run cli --workspace @av/worldlabs-atlas -- operation <id>
npm run cli --workspace @av/worldlabs-atlas -- wait <id> 30
npm run cli --workspace @av/worldlabs-atlas -- cancel <id>
npm run cli --workspace @av/worldlabs-atlas -- trace <id> trace.json
npm run cli --workspace @av/worldlabs-atlas -- task splats2Mesh body.json --paid --key mesh-1
```

`task` sends a body written by hand and spends, so it asks for `--paid`. It
prints its idempotency key: pass it back as `--key` to ask for the same task
again. World Labs' own CLI does far more; this one is what the package needs
to look after its jobs.

## Tests

```bash
npm run test --workspace @av/worldlabs-atlas
```

They run against `FakeAtlas`, an Atlas in memory that the real client talks
to through its injected transport: no request leaves the machine and nothing
waits. The fake is written from the same documentation and is as strict as
it says the service is: it refuses a field a schema does not list, replays
an idempotency key, answers 404 for a moment after accepting. It holds the
client to the documentation. It cannot show that the service agrees.

## When the real API disagrees

1. Read the operation's trace (`cli trace <id>`, or the provenance record):
   the request as it was sent, beside its result.
2. Correct the one function in `src/wire.ts`, its test, and the fake.
3. Set `WIRE.verifiedLive` to when and on what it ran.

Until then a caller can add a field without a release: every request builder
takes `extra`, merged last.

## Licence of what it makes

Not this package's to grant. World Labs' Terms give the customer what is
made through paid access, and keep what is made through free, trial or
promotional access for World Labs, licensed for personal, non-commercial
use. Read the Terms of the access the key has.
