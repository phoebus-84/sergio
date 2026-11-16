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
| Locations | Each place: what it is, its light at each time of day, what is always in frame. | `locations/<name>.md` and reference images |
| Sound | The sound world: how dialogue sits, what the ambience of each location is, what the music is and is not, the delivery loudness. | — |

Write it to be *used*: a shot's prompt is assembled from its plan, its
characters' entries and its location's entry. Vague entries produce a film
whose protagonist changes face.

When reference images are needed and do not exist, making them is part of
this stage — a character sheet, a location still — with the image tools on
the film's unit (`channel: <film>, series: _, episode: _`), filed under
`characters/` and `locations/`. `pva_budget_status` first.

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
