---
name: shot-production
version: "0.1.0"
description: Make one shot of a film — plan it against the film's bible, make or bring in its takes (footage, stock, generated, animation, graphics, screen), look at each, and propose the one for the cut
inputs:
  - name: film
    type: string
    description: The film's slug
  - name: scene
    type: string
    description: The scene's slug
  - name: shot
    type: string
    description: The shot's slug; its shot.yaml is the plan's starting point
outputs:
  - artifacts/shot-plan.md:
      kind: text/markdown
      description: How the shot is made — source, what it must show, framing, length, references to match, and what would make a take wrong
  - assets/:
      kind: directory
      description: The shot's takes — assets/video/, assets/images/, assets/audio/ — each with its provenance
  - artifacts/shot-takes.json:
      kind: file
      description: The candidates looked at, what is right and wrong with each, and the one proposed for the cut
capabilities:
  - llm
---

# Make a Shot

A shot is the smallest thing a film is made of, and the only place picture
is *made*. Two stages on the shot's unit — to every tool but the film
tools, `channel: <film>, series: <scene>, episode: <shot>`:

- **plan** → `artifacts/shot-plan.md`
- **media** → takes under `assets/`, and `artifacts/shot-takes.json`

The shot's cut and render come after, with the `film-editing` skill.

## Plan

Read `shot.yaml`; the scene's `scene.yaml` and
`artifacts/scene-direction.md`; the film's `artifacts/bible.md` with the
`characters/` and `locations/` entries this shot names; and the shots on
either side of it (`pva_film { film, scene }`) — a shot is judged by how it
cuts with its neighbours.

`artifacts/shot-plan.md`:

```markdown
# 020-close-mara — Mara looks up

**Shows.** Mara, close, lit from above by the sodium lamp; she looks up from
her watch to the clock over the entrance. Her expression changes: puzzled,
not afraid.

**Frame.** Close, eye-level, static. 4 s in the cut; make 6 for handles.

**From.** generated — still with motion.

**Holds to.** characters/mara.md (grey parka, hair tied back, the watch on
her left wrist); locations/car-park.md at night; the light of 010-wide.

**Cuts from / to.** From 010-wide (she is screen-left, walking right) to
030-insert-clock. Her eyeline must rise to screen-right.

**Wrong if.** Her face is not the face of the character sheet. The watch is
on the other wrist. Any lettering in frame. Daylight.
```

**Wrong if** is the part that matters: it is the list a take is checked
against, written before there is a take to be fond of.

Make the take longer than the shot holds — a second of handle at each end —
so the cut has room to trim and to dissolve.

## Media, by source

Check `pva_budget_status` before anything paid, and try the cheapest thing
that can be right first.

| `source` | how | cost |
| --- | --- | --- |
| `footage` | `pva_footage { film, scene, query }` finds what was shot for it. The take stays in `footage/`; the cut names it as `project:footage/media/<file>`. | free |
| `stock` | The `find-archive-media` skill: `pva_search_local_media` (already licensed in this film?), then `pva_search_media` / `pva_fetch_media`. The licence and its evidence come with the file. | free |
| `generated` | A still: `pva_generate_image`, or `pva_generate_images` for several candidates in one call. Motion: `pva_generate_wan_video` from a still (cheap; small movement, loops), `pva_generate_minimax_h3_video` (performance, dialogue, references), `pva_generate_flux3_max_video`. Load the prompting skill of the model you use. | paid |
| `animation` | The `blender-scene` skill (`pva_blender_create_scene`, `pva_blender_render`) or `pva_render_vector_animation`. | free |
| `graphics` | `pva_render_graphics`: titles, lower thirds, diagrams, motion graphics. | free |
| `screen` | `pva_render_terminal` (the `vhs-terminal-recording` skill). | free |
| `mixed` | Several of these, each a take, composited as layers in the shot's cut. | — |

Rules that hold whatever the source:

- **A generated prompt is assembled, not improvised**: what the shot shows
  (the plan), who is in it (the character entries, verbatim), where (the
  location entry), and the look (the bible). The same words every time is
  what makes shot 140 match shot 3.
- **Continuity comes from references.** When a model takes reference
  images, give it the character sheet and the previous shot's last frame
  (`pva_cut_frame` on that shot's cut writes one).
- **Still plus motion before video.** A still that is right, animated with
  a small move — by a video model, or by a `zoom` in the shot's cut — is
  cheaper and far more controllable than asking a video model for the
  whole shot. Ask for generated performance only when the shot is a
  performance.
- **Format.** The film's frame is in `film.yaml`. Generate at its aspect.
  A take of another shape is fitted in the cut (`fit: cover | contain`) and
  loses what is cropped.
- **Sound.** `sound: sync` — the take's own sound is the shot's.
  `silent` — mute it in the cut. `generated` — the picture is silent and
  the scene's sound stage makes what is heard.

## Look at every take

You cannot use what you have not looked at.

- A still: open it.
- A clip: `pva_inspect_media { film, scene, shot, path }` writes a stamped
  contact sheet under `artifacts/inspect/`. Open *that*. It also measures
  the take's size, rate, length and loudness — check them against the
  film's format.

Go down the plan's **Wrong if** list for each take, and write what you find.
A take that fails the list is not a candidate, however good it looks
otherwise. Two honest attempts that both fail mean the plan is asking for
something this source cannot give: change the approach — another model, a
still with motion, a different framing — and say so, rather than spending a
third time on the same prompt.

## The record

`artifacts/shot-takes.json`:

```json
{
  "takes": [
    { "path": "assets/video/take-01.mp4", "source": "generated", "seconds": 6.0,
      "right": "Face and parka match the sheet; eyeline rises to screen-right.",
      "wrong": "Watch is on the right wrist.", "usable": false },
    { "path": "assets/video/take-02.mp4", "source": "generated", "seconds": 6.0,
      "right": "Matches the sheet; watch correct; light matches 010-wide.",
      "wrong": "Slight shimmer in the hair in the last second: trim before 5.0 s.", "usable": true }
  ],
  "proposed": "assets/video/take-02.mp4",
  "in": 0.5,
  "seconds": 4,
  "spentUsd": 0.2
}
```

For footage, `path` is `project:footage/media/<file>`, with the `in` and
`seconds` of the part that is the take.

In `film-shot` and `film-shot-directed` the choice of take is a person's:
ask with `pva_request_approval`, naming the takes by path so they can be
opened, and saying which you propose and why. In `film-shot-auto` it is
yours: choose the proposed take and go on.

## Into the cut

Once the take is chosen, the shot's cut is one call:

`pva_assemble_cut { film, scene, shot, media: "<proposed>", in, seconds }`

and from there it is the `film-editing` skill: trim, grade to the bible,
render.
