# ADR-0057: World Labs Atlas builds a location's 3D set, behind `world.*` capabilities

## Status

Proposed. Implemented in the same change, from Atlas's documentation as read
on 2026-11-25, and **not yet run against the real service** (no key existed,
and no call was made):
- the capabilities `world.reconstruct`, `world.mesh` and `world.render`;
- `@av/worldlabs-atlas`: a client for Atlas's assets, operations and six
  tasks, with a fake provider, a price list and a small command line;
- the tools `pva_location_set`, `pva_location_views`, `pva_location_splat`,
  `pva_location_mesh` and `pva_location_sets`, on a film's spend ledger;
- a GLB as the set of `stageShot` in `@av/blender`, and `locationSet` in
  `pva_stage_shot`;
- sets in the skills `film-breakdown` and `shot-production`.

What the documentation says, what a first real run has still to settle, and
what a first reading made without the documentation got wrong, are in
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
(ADR-0007, ADR-0026).

World Labs ships more than an API, and none of it is used: its MCP server
and its CLI would put paid calls outside the spend ledger; its Blender
extension, and Blender's own splat import, need a Blender (5.3) the studio
does not support, and a GLB needs neither; its TypeScript client
(`@worldlabsai/client`) would be a dependency whose transport, clock and
waits cannot be replaced in a test, around some forty lines of HTTP. That
last choice is the one most worth revisiting once the integration has run.

- **One logical task, one name.** Atlas takes an `Idempotency-Key`: the same
  key with the same body returns the first operation and starts nothing. So
  a submission whose answer was lost is asked again under its key, never
  under a new one. The studio makes the key from the film, the set, the step
  and what was asked, so it is the same from any process: a session that
  dies before it has written the job down gets the same job back.
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
  what it was priced at, beside what it made, with signed URLs cut back to
  what they point at. Atlas keeps a trace for 30 days; the set keeps it.
- **The provider's JSON is in one file** (`wire.ts`), written from the
  documented schemas, with a `verifiedLive` that stays `null` until a real
  run has confirmed it. Atlas's requests refuse fields they do not know, so
  nothing is passed on as it came: a frame goes to the next task as exactly
  the image, camera and depth that task takes, each asset by its id. An
  answer that is not what the documentation says is an error naming that
  file. Each provenance record carries the mark.
- **The fake is as strict as the documentation.** `FakeAtlas` refuses a
  field a schema does not list, replays an idempotency key, and answers 404
  for a moment after accepting. It holds the client to the documentation; it
  cannot show that the service agrees.

### Secrets and configuration

`WLT_API_KEY` in the environment, nowhere else (ADR-0030); `WLT_API_BASE_URL`
names another API root. They are the provider's own names: its CLI and its
client read the same two. The key needs `tasks.create`, `operations.read`,
`assets.create` and `assets.read`, and `operations.cancel` to stop a job.
What is not secret and belongs to the operator's account is a library file,
`library/.render/worldlabs-atlas.json`, beside the other providers':

```json
{
  "plan": "paid",
  "credits": { "images2PosedRGBD": 100, "splats2Mesh": 1000, "atlasGenerate.perView": 50 },
  "maxWaitMinutes": 45
}
```

- **`credits`**: the prices of the account's rate card. The documentation
  prices one task, a splat (500 credits for a draft, 5,000 refined, at 1,000
  credits a dollar), and says of the rest to "use the current rate card
  shown in the platform … rather than embedding model prices in client
  code". A task whose price nobody gave is *unpriced*: under a budget the
  ledger refuses it, as it does any call it cannot check against the limit.
  No price is guessed, and the operator's price is used before the published
  one.
- **`plan`**: `paid` or `free`. The Terms give the customer what was made
  through paid access and keep what was made through free, trial or
  promotional access for World Labs, licensed for personal, non-commercial
  use, for good. The API does not say which a key's usage was.

### Where a set lives

In the film, with the location it is of, never in git (ADR-0021):

```text
<film>/locations/<name>.md                 the bible's entry, as before
<film>/locations/<name>/sets/<set>/
  set.json                                 what the set is and holds
  licence.json                             under which terms it may be used
  posed.json                               the posed frames, as the provider returned them
  posed/                                   their depth and confidence maps
  draft.spz    refined.spz                 the splat, by quality
  draft.glb    refined.glb                 the mesh of each
  views/<id>/000001.jpg …  views.json  plate.mp4
  provenance/<operation>.json              one per operation
  jobs/<step>.json                         a job submitted and not yet collected
```

It is made in steps, each its own tool, each looked at before the next:
`pva_location_set` poses the pictures; `pva_location_views` renders the
place from other sides; `pva_location_splat` makes the splat, from the posed
frames and from the views that held up; `pva_location_mesh` makes the GLB.
This is the order of Atlas's own workflow guides (*Build a scene from
images*, then *Make splats* or *Make a video*): six to twelve views round
the place, with depth, looked at *before* the long step, because "the views
are the preview of the result". It is also what lets a set start from one
picture.

Everything in a set is on one grid, chosen when it is posed: one of the four
sizes Atlas serves depth and renders views at. A splat refuses frames of two
sizes, and a single picture is not put on one of them unless it is asked.

A set is immutable in each of its parts: a quality's splat is made once, a
views id is used once, and a retake is another set. Location sets are a
film's because locations are (ADR-0050); a channel has no `locations/`.

### Money

Every paid step reserves its price on the film's ledger before the request
leaves and settles after (`paidCall`), under the capability it serves. **An
Atlas operation does not say what it was charged**, so the ledger is settled
at the price the step was asked at, and says so (`basis: estimate`); what
was really charged is on the account's Usage page. Atlas's own monthly spend
limits, per project, are a second guard and worth setting.

- A request Atlas turns away — refused, out of credits or at a spend limit
  (402), or one too many (429) — is released: nothing ran. So is a call
  interrupted before it left.
- From the moment a task is sent it is seen through: an interruption does
  not abandon the request half-way, so the job always has a name.
- A job whose wait ran out is settled at its estimate when the wait ends,
  because it may still finish and be charged; taking it up again reserves
  nothing, and does not correct that figure if the job then cost otherwise.
- A job whose session ended mid-wait leaves its reservation open, which the
  budget goes on counting. Its id is in the job's note, and whoever collects
  the job closes it, at what the job cost.
- A splat that fails is free: its page says "failed runs are free", and its
  reservation is released. No page says so of the other tasks, so a failed
  posing, render or mesh is settled at its estimate: a budget that
  overcounts by one failed run is the safer mistake.
- A job collected under its key after its note was lost is reserved a second
  time, for one charge: the ledger cannot tell a replayed operation from a
  new one. It overcounts, and says which operation both entries were.

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

- **Not run.** Nothing here has met the real service. The requests are the
  documented ones, which is far better than the first version of this change
  had (written without the documentation, it had most of them wrong); it is
  still a reading. The documentation disagrees with itself in one place this
  change depends on: the guide documents `refine: false` and `draftSplat`,
  and the reference's schema lists neither. The first real run is a test of
  `wire.ts`, to be made as a draft, and its trace is the evidence to correct
  it from.
- **720p.** Atlas renders at four sizes, none above 1280×720. A view or a plate is a
  reference to hold a generated shot to, a background to build on, a
  previsualisation. It is not a film's final picture, and the skills say so.
- **Cost and time.** A refined splat is $5 and fifteen to thirty minutes;
  what the other tasks cost is on the account's rate card only, and the rate
  card "can change". A film's budget must be declared for these tools to be
  worth trusting unattended.
- **Licence.** What is made through free, trial or promotional access is
  World Labs', for personal, non-commercial use, and stays so after an
  upgrade; what is uploaded may train its models, with an opt-out for paid
  accounts only. Every set says which access it was made under, and a set
  made under free or unstated access is marked as not for commercial use.
- **What is sent.** A location's pictures leave the machine and stay in the
  project at World Labs until they are deleted there. The tools say so; the
  account's settings, and `purgeContentOnOperationCompletion`, which the
  tools do not yet use, decide how long.
- **The provider's future.** World Labs is now part of AMD. Hosts, prices,
  terms and the API itself may change or go; its rate limits are "to be
  announced". What the studio keeps is neutral: an `.spz`, a GLB, JPEGs,
  EXRs, and capability names that do not mention Atlas. Losing the provider
  loses the ability to make new sets, not the sets.
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
- `pva_capability_status` reports the provider as *written from the
  documentation, not yet run* until `verifiedLive` is set.

## Not here yet

- Webhooks: the client waits by looking (or by `:wait`, 30 seconds at a
  time).
- A set from words alone: `atlasTextToImage` with `returnDepth` returns a
  picture already posed, which the client can ask for and no tool does.
- Edits to a set's views (`atlasChisel`), and asking Atlas to purge what a
  step used.
- A viewer for `.spz` in the browser studio, and splats in Blender itself.
- Marks in a reconstructed set (a GLB from Atlas names no objects).
- An operator-signed approval for a refined pass, as golden references have.
- Sets for a channel's series.
