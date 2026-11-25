# @av/worldlabs-atlas

A client for [World Labs Atlas](https://docs.atlas.worldlabs.ai/): pictures of
a place become estimated cameras and depth, then a Gaussian splat, then a
polygon mesh; and the place can be seen again from cameras it is given.

It knows nothing of films or episodes. It is useful to anything that wants a
3D place from photographs and has an Atlas key.

> **Not yet run against the real service.** The documentation could not be
> read when this was written, and no call was made. Paths, the key's header
> and a splat's price rest on reports of the provider's pages; request bodies
> rest on less. Every shape of the provider's JSON is in `src/wire.ts`, whose
> `WIRE.verifiedLive` is `null` until a real run has confirmed it. What is
> known and what is not: `docs/notes/worldlabs-atlas-api.md` in the
> repository. The first real call should be a draft.

## What it does

| | Atlas task | here |
|---|---|---|
| pictures → posed frames with depth | `images2PosedRGBD` | `client.poseImages` |
| posed frames → a splat (`.spz`), draft or refined | `posedImages2Splats` | `client.splatsFromPosedImages` |
| a splat → a mesh (GLB) | `splats2Mesh` | `client.meshFromSplats` |
| posed frames + cameras → views | `atlasGenerate` | `client.generateViews` |
| words → a picture; a picture edited | `atlasTextToImage`, `atlasChisel` | `client.textToImage`, `client.chisel` |

Around them: uploads (`uploadFile`), operations (`getOperation`,
`waitUntilDone`, `cancelOperation`, `traceOperation`, `listOperations`),
downloads (`download`), cameras (`orbit`, `push`, `placed`, `sceneFocus`), a
price list (`estimate`) and a record of how each file was made
(`provenanceOf`).

```ts
import { createAtlasClient, readPosedFrames, provenanceOf } from "@av/worldlabs-atlas";

const atlas = createAtlasClient();               // WORLDLABS_API_KEY
const images = await Promise.all(files.map((file) => atlas.uploadFile(file)));
const posed = await atlas.poseImages({ images });
const frames = readPosedFrames(posed.operation.response);

const request = { posedFrames: frames, refine: false };          // a draft: a tenth of the price
const splat = await atlas.splatsFromPosedImages(request, {
  onSubmitted: (operation) => remember(operation.id),            // before any waiting
});
const bytes = await atlas.download(splat.files.find((file) => file.kind === "splat")!);
const record = provenanceOf(splat, request);                     // keep it beside the file
```

## Three rules

- **A task is submitted once.** A submission whose answer is lost may be a
  job accepted and charged, so it is never retried. Requests that only read
  are, with a backoff that honours `Retry-After`.
- **A wait that ends leaves the job running.** A splat takes a quarter of an
  hour. `AtlasTimeoutError` and `AtlasCancelledError` name the operation;
  `client.resume(task, operationId)` takes it up again, from any process.
  `cancelOnAbort` asks Atlas to stop the job when the caller gives up.
- **Nothing is chosen silently.** No other host, quality or task is tried
  when one fails, and a price nobody published is `priced: false`, not a
  guess.

## Configuration

| variable | |
|---|---|
| `WORLDLABS_API_KEY` | the project's API key, sent as `WLT-Api-Key`. Required. The name is this package's: the documentation's own was not read |
| `WORLDLABS_ATLAS_BASE_URL` | another origin than `https://api.atlas.worldlabs.ai`; no path |
| `WORLDLABS_ATLAS_MAX_RETRIES` | how often a read is asked again; default 4 |

## Money

1,000 credits to the dollar. A draft splat is 500 credits, a refined one
5,000: the only prices that were public. `estimate(task, request, operator)`
takes the rest from whoever holds the account's rate card, and says
`unknown` otherwise. What an operation reports charging (`TaskRun.cost`)
replaces any estimate.

## Command line

```bash
npm run cli --workspace @av/worldlabs-atlas -- health            # no key, no charge
npm run cli --workspace @av/worldlabs-atlas -- prices
npm run cli --workspace @av/worldlabs-atlas -- operation <id>
npm run cli --workspace @av/worldlabs-atlas -- wait <id> 30
npm run cli --workspace @av/worldlabs-atlas -- cancel <id>
npm run cli --workspace @av/worldlabs-atlas -- trace <id> trace.json
npm run cli --workspace @av/worldlabs-atlas -- task splats2Mesh body.json --paid
```

`task` sends a body written by hand: the way to try a request shape against
the real service before correcting `wire.ts`. It spends, so it asks for
`--paid`.

## Tests

```bash
npm run test --workspace @av/worldlabs-atlas
```

They run against `FakeAtlas`, an Atlas in memory that the real client talks
to through its injected transport: no request leaves the machine and nothing
waits. The fake speaks the shapes of `wire.ts`, so it checks this package
against itself; it cannot show that the service agrees.

## When the real API disagrees

1. Read the operation's trace (`cli trace <id>`, or the provenance record).
2. Correct the one function in `src/wire.ts`, and its test.
3. Set `WIRE.verifiedLive` to when and on what it ran.

Until then a caller can put a field right without a release: every request
builder takes `extra`, merged last.

## Licence of what it makes

Not this package's to grant. Outputs of a free Atlas account are reported to
be for personal, non-commercial use; paid API access is reported to allow
commercial use. Read the terms of the plan the key belongs to.
