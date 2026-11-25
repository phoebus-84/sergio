---
name: film-breakdown
version: "0.1.0"
description: Turn a screenplay into a film that can be made — its bible (look, characters, voices, locations, sound), its scenes and shots created as units in running order, and each scene's direction (how it is covered)
inputs:
  - name: film
    type: string
    description: The film's slug; artifacts/screenplay.md is what is broken down
  - name: scene
    type: string
    description: For a scene's direction stage, the scene's slug
outputs:
  - artifacts/bible.md:
      kind: text/markdown
      description: The film's look, characters and voices, locations and sound world, with the references every shot is held to
  - artifacts/breakdown.json:
      kind: file
      description: Every scene and shot created, in order, with where its picture comes from and what it is estimated to cost
  - artifacts/scene-direction.md:
      kind: text/markdown
      description: A scene's direction — what it is for, how it is covered, its shots in cutting order and the sound it needs
capabilities:
  - llm
---

# Break a Film Down

Three stages share this skill. On the film's unit (`<film>/_/_`): **bible**
(`artifacts/bible.md`) and **breakdown** (`artifacts/breakdown.json`). On a
scene's unit (`<film>/<scene>/_`): **direction**
(`artifacts/scene-direction.md`).

The screenplay says what happens. This work decides what is *seen and
heard*, shot by shot, and makes each of those a unit the studio can produce.

## The bible

One document that every scene and shot is held to, so shot 140 looks like it
belongs to the film shot 3 is in. `artifacts/bible.md`, and the pieces it
points at filed where the tools look for them:

| section | says | its files |
| --- | --- | --- |
| Look | Aspect and frame, palette, light, lens character, grain, what the camera never does. If generated: the model and the words every prompt carries. If graded: the grade, as effects from `pva_cut_effects`. | `bible/`, `references/` |
| Characters | One entry each: who they are, what they look like in words a model can hold to, what they wear, how they speak. | `characters/<name>.md` and reference images |
| Voices | Which voice speaks each character and the narration: a speaker or a clone from `pva_voices`, with the direction for the read. | `voices/` |
| Locations | Each place: what it is, its light at each time of day, what is always in frame. | `locations/<name>.md` and reference images; for a place many shots return to, a 3D set in `locations/<name>/sets/` |
| Sound | The sound world: how dialogue sits, what the ambience of each location is, what the music is and is not, the delivery loudness. | — |

**When the film has a style** (`pva_style { film }` says so), the *Look*
section starts from its brief, written for the film, and adds only what the
film decides beyond it; values (colours, timing, grain) are cited from the
brief, never re-invented. Load the skills the style names. A scene that needs
a different look gets its own style (`pva_apply_style { channel: film, series:
scene, fromParent: true }`, then `pva_set_style`) rather than a note in prose.

Write it to be *used*: a shot's prompt is assembled from its plan, its
characters' entries and its location's entry. Vague entries produce a film
whose protagonist changes face.

When reference images are needed and do not exist, making them is part of
this stage — a character sheet, a location still — with the image tools on
the film's unit (`channel: <film>, series: _, episode: _`), filed under
`characters/` and `locations/`. `pva_budget_status` first.

### A location's 3D set

Pictures hold one angle each. A place that shots return to from several
sides — a room, a yard, a street corner — drifts between them: the door
moves, the window changes wall. A *set* is that place in three dimensions,
made once from its pictures, and every angle is then taken from it: stills
to hold a generated shot to, a mesh for Blender's camera, a plate.

Make one when a location has **three or more shots from different sides**,
or characters are **staged** in it (`source: animation`). A place seen once,
or always from the same side, needs its reference picture and nothing more.

It is made by World Labs Atlas, paid, on the film's budget
(`pva_capability_status` says whether it is wired, and `pva_location_sets
{ film }` what each step costs). In this order, looking after each step:

1. **Pictures.** One can start a set; 8–16 frames make a room, and the
   views of step 3 count among them. Photographs of the real place if the
   film has them (footage stills count), otherwise reference pictures
   generated to the location's entry — the same place, from positions that
   differ, not turned on the spot. Wide or medium, overlapping, nobody and
   nothing moving in them. They need not be one size: the set puts them on
   its own (`size`, 1280x720 unless the film is upright), cropping what
   does not fit, so keep what matters away from the edges. File them under
   `locations/<name>/`.
2. **`pva_location_set { film, location, set, pictures }`** estimates each
   picture's camera and depth. With several photographs of a real place
   that is going to a refined splat, `refinePoses: true` tightens the
   cameras.
3. **`pva_location_views { …, viewsId, path: "orbit" }`** renders the place
   from the sides no picture showed — six to twelve views, all round by
   default, each with its depth. Open every still: this is where a set that
   will not hold together shows, for the price of a few views. What no
   picture showed is invented, and you are looking at the invention; views
   that contradict each other are made again (another `viewsId`), not sent
   on. From one picture, expect less the further the camera goes from it.
4. **`pva_location_splat { …, withViews: [viewsId] }`** makes the splat
   from the posed frames and the views that held. **The first is always a
   draft** — a tenth of the price, half a minute, not a quarter of an hour
   or two — and it answers the only question that matters yet: do the
   frames make one place? If they do not, the fix is better pictures or
   better views in another set, never a refined pass over the same ones.
5. **The refined splat is the operator's decision, not yours.** When the
   draft holds and the film needs more than a draft gives, write the
   proposal into the location's entry in the bible — what the draft and
   its views showed, what refining costs and how long it takes — and ask:
   in `film-project`, the bible's own approval is the question
   (`pva_request_approval { channel: <film>, series: _, episode: _,
   stageId: "bible", note }`); otherwise ask in words. Then stop. Only
   when they have said yes: `pva_location_splat { quality: "refined",
   approvedBy: "<who, and how they said it>" }`. `film-project-auto` does
   not change this: unattended is not approved, and a film made that way
   keeps its drafts.
6. **`pva_location_mesh { … }`** when a shot is staged in the place: a GLB
   for `pva_stage_shot`.

A step whose wait runs out is not lost and must not be asked for again
under another name: call the same tool with the same arguments, and it
waits for the job it already paid for.

Three limits to write into the bible's entry for the location, so that no
shot plan forgets them:

- **720p at most.** A view or a plate from a set is a *reference* and a
  *background to build on*. It is never the film's final picture: a shot
  that shows the place is generated or rendered at the film's frame, held to
  the set's stills.
- **The licence follows the account's plan**, and every set records it
  (`licence.json`). A set made under a free or an unstated plan is not for
  a film that will be sold or monetised: say so to the operator before
  building shots on it.
- **Reconstructions invent.** A wall nobody photographed is a guess. A set
  is evidence of the place only where the pictures looked.

What the sets cost is part of what the film costs: `artifacts/breakdown.json`
lists them beside the scenes — `"sets": [{ "location": "yard", "set": "a",
"spentUsd": 1.6 }]` — and counts them in `totals.estimatedCostUsd`.

## The breakdown

Read `artifacts/screenplay.md`, `artifacts/bible.md` and the footage log
(`pva_footage { film }`). Then, scene by scene:

1. **Create the scene** — `pva_create_scene` with a slug that sorts
   (`010-car-park`, `020-ward`: tens leave room to insert), `number` and
   `heading` from the screenplay's own, `setting`, `location`, `timeOfDay`,
   a `summary` of what happens and what the scene is for, its `characters`,
   and `durationTargetSeconds` from the screenplay's estimate. Group scenes
   into sequences and acts with `sequence`, `sequenceTitle`, `act`.

2. **Decide its coverage** — the shots that tell it. Start from what the
   audience must see to follow the scene, not from a list of sizes. A
   two-line exchange may be one shot; an arrival may be three.

3. **Create each shot** — `pva_create_shot`, slugs again in tens
   (`010-wide`, `020-close-mara`), with:

   | field | values |
   | --- | --- |
   | `source` | `footage` (shot for the film, in footage/) · `stock` (archive, verifiable licence) · `generated` (image or video model) · `animation` (Blender, rigged vectors) · `graphics` (titles, diagrams, motion graphics) · `screen` (screen or terminal recording) · `mixed` (several, composited in the shot's cut) |
   | `size` | extreme-wide · wide · full · medium-wide · medium · medium-close · close · extreme-close · insert |
   | `angle` | eye-level · high · low · overhead · ground · dutch · over-the-shoulder · point-of-view |
   | `movement` | static · pan · tilt · push-in · pull-out · track · crane · handheld · steadicam · zoom · orbit · aerial |
   | `sound` | `sync` (recorded with the picture) · `silent` · `generated` (made afterwards) |
   | `durationSeconds` | how long it holds in the cut |
   | `description` | what the shot shows and what happens in it — the sentence a take is judged against |
   | `dialogue` | the lines spoken in it: `{ character, line, delivery?, offscreen? }` |

4. **Assign footage.** When footage exists, a shot it can serve is
   `source: footage`, and the clip is marked for it:
   `pva_footage { film, annotate: { id, scene, shot } }`. Use what was shot
   before generating what was not.

Choosing a source is choosing a cost and a risk. Footage and graphics are
free and exact. A generated still with a camera move in the cut is cheap and
reliable. A generated performance is the most expensive thing here and the
least controllable: spend it on the shots that need it.

The shots' `durationSeconds` in a scene should add up to the scene's
target, and the scenes' to the film's. Check the sum before you finish.

### The record

`artifacts/breakdown.json`:

```json
{
  "scenes": [
    { "slug": "010-car-park", "number": "1", "sequence": "arrival", "seconds": 35,
      "shots": [
        { "slug": "010-wide", "source": "footage", "seconds": 6, "footage": "a001-c004-0309e0e6" },
        { "slug": "020-close-mara", "source": "generated", "seconds": 4, "estimatedCostUsd": 0.5 }
      ] }
  ],
  "totals": { "scenes": 14, "shots": 96, "seconds": 598, "bySource": { "footage": 41, "generated": 38, "graphics": 9, "stock": 8 }, "estimatedCostUsd": 31.5 },
  "risks": ["Scene 9 needs a crowd: no footage, and a generated one will not hold up at this size."]
}
```

`pva_film { film }` must show every scene and shot of the record, in
order, when you are done. A person approving the breakdown is approving the
shot list and its estimated cost: both are in this file, and both must be
true.

## A scene's direction

On a scene's unit, before its shots are produced. Read `scene.yaml`, the
scene in the screenplay, the bible, and the shots the breakdown gave it —
then decide the scene, and bring the shot list in line with the decision
(`pva_create_shot` for a new one, `pva_update_unit { film, scene, order }`
for the cutting order, `pva_update_unit { film, scene, shot, set }` to
change one).

`artifacts/scene-direction.md`:

```markdown
# <number>. <heading>

**For.** What this scene changes, in a sentence.

**Coverage.** How it is told and why: where we are, whose scene it is, what
the camera withholds.

## Shots, in cutting order
1. `010-wide` — wide, static, 6 s. The car park, empty; Mara's car arrives. *footage*
2. `020-close-mara` — close, eye-level, 4 s. She reads the clock. *generated*

## Sound
- Dialogue: MARA "That can't be right." (under her breath)
- Ambience: night air, distant traffic, a ventilation hum from the building.
- Effects: car door, footsteps on wet tarmac.
- Music: none until the cut to the ward.

## Joins
In from black, 12 frames. Out on a hard cut on the door.
```

The **Sound** section is the brief for the scene's sound stage, and the
**Joins** section for its cut: write them to be acted on.
