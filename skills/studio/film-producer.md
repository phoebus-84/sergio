---
name: film-producer
version: "0.1.0"
description: Produce a film — a self-contained work, short or feature length — at its three levels (film, scene, shot); decide what to do next from where each unit stands, run the levels' pipelines, and keep a person in the loop exactly as far as they asked to be
inputs:
  - name: film
    type: string
    description: The film's slug, or the idea, script or footage a new film is to be made from
  - name: control
    type: string
    description: How much a person decides — every step, the creative steps, or only the final review — when they said
outputs:
  - library/<film>/:
      kind: directory
      description: The film — film.yaml, its knowledge, scenes/<scene>/shots/<shot>/ — with a cut and a render at every level
  - artifacts/scenes-report.json:
      kind: file
      description: For the film's `scenes` stage, each scene with the render it reached
  - artifacts/shots-report.json:
      kind: file
      description: For a scene's `shots` stage, each shot with the render it reached
capabilities:
  - video.compose
---

# Produce a Film

A film is not an episode of anything. It is one work, made once, and it is
produced at **three levels**, each a production unit with its own files, its
own pipeline, its own cut and its own renders (ADR-0050):

```
library/<film>/                      the film       film.yaml      pipeline film-project
  bible/ characters/ locations/      what every scene and shot is held to
  references/ voices/ sources/ skills/
  footage/                           what was shot, recorded or bought (catalog.json)
  music/                             the score and licensed music
  scenes/<scene>/                    a scene        scene.yaml     pipeline film-scene
    references/ sources/ skills/
    shots/<shot>/                    a shot         shot.yaml      pipeline film-shot
      assets/                        its takes
      artifacts/cut.json             its cut        (every level has one)
      output/                        its renders    (every level has them)
```

A shot's render is a source of its scene's cut; a scene's render is a source
of the film's. So a change to one shot costs one shot's render and a re-join
above it, and a feature is rendered in the pieces that changed.

## Addressing a unit

The film tools take `film`, and optionally `scene` and `shot`. **Every other
tool of the studio** — pipeline, budget, approval, generation, voice, archive —
takes the same unit as `channel` / `series` / `episode`, with `_` for the
level itself:

| unit | film tools | every other tool |
| --- | --- | --- |
| the film | `film` | `channel: <film>, series: _, episode: _` |
| a scene | `film, scene` | `channel: <film>, series: <scene>, episode: _` |
| a shot | `film, scene, shot` | `channel: <film>, series: <scene>, episode: <shot>` |

## First, read where it stands

`pva_film { film }` is the film in running order: every scene and shot with
its length and its state, and **what stands between the film and its final
render, first things first**. Read it before deciding anything, and again
after every piece of work.

| state | what it means | what it wants |
| --- | --- | --- |
| no cut | the unit has no `artifacts/cut.json` | make its media, then `pva_assemble_cut` |
| invalid | its cut does not hold | fix what `pva_check_cut` names |
| blocked | something under it has no current final render | work on that first |
| ready to render | a cut, never rendered | `pva_render_cut` |
| stale | the cut or a source changed since its render | `pva_render_cut` |
| preview only | only a preview is current | a final `pva_render_cut` |
| current | its final render is of its cut as it is | nothing |

Work **bottom-up**: shots, then their scene, then the film. A final render of
a level cascades down by itself — it renders first whatever under it is out
of date — but it cannot make a shot's media or a scene's sound for you.

## Starting a film

1. `pva_create_film` with a slug, a title and a **delivery format**. The
   format (frame size and rate) is the one decision that is expensive to
   change later: every cut of the film is made in it. Ask if it was not said;
   default to `hd-24`.
2. Put what the person gave you where it belongs before writing anything:
   a script or notes under `sources/`, reference pictures under `references/`,
   footage through `pva_ingest_footage` (the `footage-ingest` skill).
3. Read the film's own skills (`pva_list_skills`): a film can carry its own
   procedures under `skills/`, as can a scene.
4. Run the film's pipeline: `pva_run_pipeline` on `<film>/_/_`.

## The pipelines, and who decides

| level | pipeline | a person approves |
| --- | --- | --- |
| film | `film-project` | development, screenplay, look and sound, breakdown, music, the cut, the final review |
| film | `film-project-auto` | the final review only |
| scene | `film-scene` | the direction and the cut |
| scene | `film-scene-auto` | nothing |
| shot | `film-shot` | the choice of take |
| shot | `film-shot-auto` | nothing |
| shot | `film-shot-directed` | the plan, the take and the cut |

A level names its pipeline in its `pipeline.yaml`, and may name the one the
levels under it run:

```yaml
# library/<film>/pipeline.yaml
pipeline: film-project
scenes: film-scene        # every scene, unless its own pipeline.yaml says otherwise
shots: film-shot-auto     # every shot, unless its scene or the shot itself says otherwise
```

So "do it all yourself and show me the film" is `film-project-auto` with
`scenes: film-scene-auto` and `shots: film-shot-auto`; "I direct every shot"
is `shots: film-shot-directed`; and one difficult scene can be directed by
hand inside an otherwise automatic film by a `pipeline.yaml` of its own.
**Set this from what the person asked for, and say what you set.** When they
did not say, leave the defaults: they ask at the creative steps.

Whatever the pipeline, two things are always the person's:

- **Approvals.** A gate is asked with `pva_request_approval`. You never
  approve; you never work around a gate by doing a later stage's work early.
- **Locks.** A clip or a track a person locked in a cut is theirs. Assembly
  leaves it alone and `pva_edit_cut` refuses to touch it. Do not ask for it
  to be unlocked unless it is in the way of what they asked.

## The stages that run other levels

The film's `scenes` stage and a scene's `shots` stage are yours:

1. `pva_film` for the units under this one, in order.
2. For each that is not current, run its own pipeline to its end
   (`pva_run_pipeline` on the unit), stage by stage, with the skill each
   stage names. Units that do not depend on each other can be worked in any
   order; finish one before starting the next unless the person asked for
   breadth first.
3. A unit waiting on a person stops there. Record it as waiting, go on with
   the others, and say at the end which ones wait and for what.
4. Write the stage's report — `artifacts/scenes-report.json` or
   `artifacts/shots-report.json`:

   ```json
   { "units": [ { "slug": "010-car-park", "state": "current", "renderId": "final-…", "seconds": 6.3 },
                { "slug": "020-ward", "state": "waiting", "waitingOn": "approval of the cut" } ] }
   ```

   The stage is complete when every unit is `current`, or the report says
   exactly which are not and why.

## Money

Everything the film tools do is local and free: FFmpeg on this machine.
What costs is generating pictures, clips and voices, and those tools reserve
on the unit's ledger. A film's budget is declared once on the film and is
shared by every scene and shot under it: `pva_budget_status` on any unit of
the film shows what is left for all of them. Check it before a batch of
generation, and before choosing a costly model for a shot that a cheaper one
or a piece of footage would serve.

## Which skill for which stage

| stage | skill |
| --- | --- |
| film: development, screenplay | `film-development` |
| film: look and sound, breakdown · scene: direction | `film-breakdown` |
| bringing footage in, logging it | `footage-ingest` |
| shot: plan, media | `shot-production` |
| scene: sound · film: music | `film-sound` |
| any level: cut, render, review | `film-editing` |

## When you report

Say what state the film is in, in its own terms: how many scenes and shots
are current, what is waiting on a person and for what, what is blocked and
by what, what was spent. Name renders by their path. If something was
skipped or failed, say so with what the tool said.
