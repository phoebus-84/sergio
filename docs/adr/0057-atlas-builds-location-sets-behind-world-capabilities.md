# ADR-0057: World Labs Atlas builds a location's 3D set, behind `world.*` capabilities

## Status

Proposed. Implemented in the same change, and **not yet run against the real
service** (no key existed, and no paid call was made):
- the capabilities `world.reconstruct`, `world.mesh` and `world.render`;
- `@av/worldlabs-atlas`: a client for Atlas's assets, operations and six
  tasks, with a fake provider, a price list and a small command line;
- the tools `pva_location_set`, `pva_location_views`, `pva_location_splat`,
  `pva_location_mesh` and `pva_location_sets`, on a film's spend ledger;
- a GLB as the set of `stageShot` in `@av/blender`, and `locationSet` in
  `pva_stage_shot`;
- sets in the skills `film-breakdown` and `shot-production`.

What was known of the API when this was written, and how, is in
[the notes](../notes/worldlabs-atlas-api.md).

## Context

A film's locations are a Markdown entry and a few reference pictures
(ADR-0050, `locations/<name>.md`). Every shot in a place is then generated
from words and whichever picture is at hand, and the place drifts: the door
moves, the window changes side, the light comes from elsewhere. ADR-0010
made visual continuity an artifact; for a place, pictures are a weak one,
because a new angle is exactly what they do not hold.

The studio can already film a 3D place: `stageShot` puts characters on a
`.blend` set (ADR-0033, ADR-0052). It has no way to *get* such a place
short of modelling it.

World Labs' Atlas (open to everyone since 2026-11-12) turns a few
photographs or reference pictures of a place into estimated cameras and
depth, then a Gaussian splat, then a polygon mesh, and renders the scene from
cameras it is given. That is the missing step: a place that exists once, in
three dimensions, from which every angle is taken.

## Decision

### Three capabilities, named for what is made

| capability | from | to |
|---|---|---|
| `world.reconstruct` | pictures of one place | a navigable reconstruction of it: posed views with depth, and a Gaussian splat |
| `world.mesh` | a reconstruction | a polygon mesh of it (GLB) |
| `world.render` | a reconstruction and a path of cameras | the place seen from each camera: stills, and a plate joined from them |

- **`world`, not `splat` or `atlas`.** A capability names what a stage wants
  (ADR-0015). A splat is one provider's intermediate format, and the next
  one may go from pictures to a mesh without it.
- **Not `scene.*`.** `scene.create` makes an *editable source* and
  `scene.render` renders a saved one, the same way each time (ADR-0033). A
  world is estimated from pictures and cannot be edited where it is made;
  `world.render` asks a model for a view and gets one that may contain what
  no picture showed. A stage must be able to ask for one without getting
  the other.
- **Not `model.generate`.** That is one object from one picture, to be
  rigged or placed (ADR-0052). A world is a place one stands in.
- **Three, not one.** They are priced, timed and reviewed apart: a draft
  reconstruction costs a tenth of a refined one, a mesh is only needed for
  Blender, and views are asked for many times from one reconstruction.

Atlas's two image tasks (`atlasChisel`, `atlasTextToImage`) are in the
client and behind no capability: the studio has `image.generate` and
`image.edit` with other providers, and adding Atlas as a third would need a
`defaultProviders` choice nobody has asked for.

### A dedicated adapter, as for fal

`@av/worldlabs-atlas` owns the HTTP, the uploads, the wait, cancellation,
the download and the record of each operation, and knows nothing of films
(ADR-0007, ADR-0026). Atlas's own MCP server and its Blender extension are
not used: the first would put paid calls outside the spend ledger, the
second needs a Blender (5.3) the studio does not support, and a GLB needs
neither.

- **A task is submitted once.** A submission whose answer is lost may be a
  job accepted and charged; only requests that read are retried.
- **A wait that ends leaves the job running.** Jobs take a quarter of an
  hour and more. The operation's id is written into the set before the wait
  begins and stays there until what the job made is on disk; a wait that
  times out, a session that dies, a download that fails, is taken up again
  on the same operation, never by asking again.
- **Giving up is not cancelling.** Interrupting a tool call stops the
  waiting. A job is stopped by name (`pva_location_sets { cancel }`),
  because what a job stopped part-way is charged is not known. The client
  can cancel on interruption (`cancelOnAbort`); the studio does not ask it to.
- **Every operation's `:trace` is kept** with its request, its result and
  what it cost, beside what it made, with signed URLs cut back to what they
  point at.
- **The provider's JSON is in one file** (`wire.ts`), marked as unverified,
  with a `verifiedLive` that stays `null` until a real run has confirmed it.
  Requests are one plain guess each; answers are read in the several
  spellings such an API may use, and an answer that is not understood is an
  error naming that file. Each provenance record carries the mark.

### Secrets and configuration

`WORLDLABS_API_KEY` in the environment, nowhere else (ADR-0030).
`WORLDLABS_ATLAS_BASE_URL` names another host. What is not secret and
belongs to the operator's account is a library file,
`library/.render/worldlabs-atlas.json`, beside the other providers':

```json
{
  "plan": "paid",
  "credits": { "images2PosedRGBD": 100, "splats2Mesh": 1000, "atlasGenerate.perView": 50 },
  "maxWaitMinutes": 45
}
```

- **`credits`**: the prices of the account's rate card. Only a splat's
  price was public (500 credits for a draft, 5,000 refined, at 1,000 credits
  a dollar). A task whose price nobody gave is *unpriced*: under a budget
  the ledger refuses it, as it does any call it cannot check against the
  limit. No price is guessed.
- **`plan`**: `paid` or `free`. The API does not say which plan a key
  belongs to, and the licence depends on it.

### Where a set lives

In the film, with the location it is of, never in git (ADR-0021):

```text
<film>/locations/<name>.md                 the bible's entry, as before
<film>/locations/<name>/sets/<set>/
  set.json                                 what the set is and holds
  licence.json                             under which terms it may be used
  posed.json                               the posed frames, as the provider returned them
  posed/                                   their depth maps
  draft.spz    refined.spz                 the splat, by quality
  draft.glb    refined.glb                 the mesh of each
  views/<id>/000001.png …  views.json  plate.mp4
  provenance/<operation>.json              one per operation
  jobs/<step>.json                         a job submitted and not yet collected
```

It is made in steps, each its own tool, each looked at before the next:
`pva_location_set` poses the pictures; `pva_location_views` renders the
place from other sides; `pva_location_splat` makes the splat, from the posed
frames and from the views that held up; `pva_location_mesh` makes the GLB.
This is the order World Labs' own agent skills follow: a few views to look
at *before* the long step.

A set is immutable in each of its parts: a quality's splat is made once, a
views id is used once, and a retake is another set. Location sets are a
film's because locations are (ADR-0050); a channel has no `locations/`.

### Money

Every paid step reserves its estimate on the film's ledger before the
request leaves and settles after (`paidCall`), under the capability it
serves, at what the operation says it charged when it says.

- A request Atlas refuses is released: nothing ran.
- A job whose wait ran out is settled at its estimate when the wait ends,
  because it may still finish and be charged; taking it up again reserves
  nothing.
- A run that fails at Atlas is reported to be free. That is a third party's
  word, so unless the failed operation itself states its charge the
  reservation is settled at the estimate: a budget that overcounts by one
  failed run is the safer mistake.

### A draft first, and the refined one by the operator's word

- The first splat of a set is always a **draft**. The tool refuses a
  refined splat for a set that has no draft.
- A **refined** splat is asked for only with the operator's go-ahead, which
  the call must carry (`approvedBy`) and the set records. This is a
  statement the agent makes and the record keeps, not a signature: the tools
  run as the same user as the agent, as the spend ledger's own note says of
  the provider keys. What does bind is the film's budget, and, under Claude
  Code, the permission a paid tool asks for.

### No silent fallback

A draft is not handed over when a refined splat fails; a views request that
the service refuses is not retried at another size; no other provider is
tried; a price that is not known is not assumed. Each failure says what
failed and what was left running or charged.

### Into Blender

`stageShot` takes a GLB as its set as well as a `.blend`. A GLB brings no
light, world, frame rate or marks of its own, so the stage supplies the
first three as it does for an empty stage, and places are given in metres;
`setPlacement` scales, turns and moves a set whose units and origin are a
reconstruction's, not a designer's. `.blend` sets behave as before.

## Risks

- **Unverified.** Nothing here has met the real service. The paths, the
  key's header and the splat's prices rest on summaries of the provider's
  pages and on third parties; the bodies of requests rest on less. The first
  real run is a test of `wire.ts`, to be made as a draft, and its trace is
  the evidence to correct it from.
- **720p.** The API renders at 1280×720 at most. A view or a plate is a
  reference to hold a generated shot to, a background to build on, a
  previsualisation. It is not a film's final picture, and the skills say so.
- **Cost and time.** A refined splat is $5 and up to twenty-five minutes;
  what the other tasks cost is not public. A film's budget must be declared
  for these tools to be worth trusting unattended.
- **Licence.** Outputs of a free account are reported to be for personal,
  non-commercial use, with rights kept by World Labs, and uploads may train
  its models. Every set says which plan it was made under, and a set made
  under a free or an unstated plan is marked as not for commercial use.
- **The provider's future.** World Labs was acquired by AMD days after
  Atlas opened. Hosts, prices, terms and the API itself may change or go.
  What the studio keeps is neutral: an `.spz`, a GLB, PNGs, and capability
  names that do not mention Atlas. Losing the provider loses the ability to
  make new sets, not the sets.
- **Reconstructions invent.** What no picture showed is made up, in the
  splat and more so in rendered views. A set is looked at from every side
  before a shot is held to it.

## Consequences

- A location can be one object that every shot in it is taken from: stills
  for a generator's references, a mesh for Blender's camera.
- A fourth kind of paid call joins the ledger, and the first whose jobs
  outlast a tool call's patience: sets carry their pending jobs on disk.
- Three more capabilities, with one provider and no `defaultProviders`
  entry: a second provider will need one.
- `pva_capability_status` reports the provider as *wired, unverified* until
  `verifiedLive` is set.

## Not here yet

- Webhooks: the client waits by looking.
- A viewer for `.spz` in the browser studio, and splats in Blender itself.
- Marks in a reconstructed set (a GLB from Atlas names no objects).
- An operator-signed approval for a refined pass, as golden references have.
- Sets for a channel's series.
