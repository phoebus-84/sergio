---
name: style-templates
version: "0.1.0"
description: Make a channel, series, film or scene in a ready-made style when the person asks for one — find the template they named, apply it, read its brief for each unit, change its parameters (a palette, a timing, a font) and keep an edited style as a template of its own
inputs:
  - name: request
    type: string
    description: What the person asked, with the style they named ("in the woodblock style", "usando 'Tide riso'"), if any
outputs:
  - style/:
      kind: directory
      description: The level's own copy of the style — STYLE.md, style.json, params/*.json, style.yaml
capabilities:
  - llm
---

# Style templates

A style template is an **easier road, never a requirement**. A channel, a
series, a film or a scene with no style is made exactly as before, with any
process and any look. A style gives a ready-made look *and* a way of making
it — a brief, a palette, values, the skills to load, the format a film starts
in — so the first steps are scaffolded instead of invented.

Only use one when the person asked for it, named one, or agreed when you
offered. Never apply a style on your own initiative.

## What a style is

```
<template>/                       studio/style/templates/ · <library>/_styles/ · <project>/styles/
  style.json                      id, title, summary, its parameter files, what it suggests (scaffold)
  STYLE.md                        the brief — values written as {{placeholders}}, never inline
  params/palette.json             a palette: colours by id, each #rrggbb with a name and a role
  params/<id>.json                named values: a number, a menu, a switch, a colour, a font, a text
```

The brief says "print it in {{palette}}" or "the accent is
{{palette.accent}}", and the value comes from `params/palette.json`. That is
the rule that makes a style parametric: **a value lives in one parameter file
and nowhere else.** Placeholders: `{{param}}` (the whole file, as prose),
`{{param.entry}}` (a colour's hex, a field's value), `{{param.entry.name}}`,
`.role`, `.label`; and `{{unit.title}}`, `{{unit.idea}}`, `{{unit.level}}` —
filled from the unit the brief is read for.

## When a person names a style

1. `pva_styles { name: "<what they said>", project }` — a name is matched by
   id, by title, then by the one template it is part of. If it is ambiguous or
   unknown, the tool lists the candidates: ask which one.
2. Apply it where they meant it:
   - a new film: `pva_create_film { …, style }` — the film takes the style's
     format unless one was asked for;
   - a new series or channel: `pva_create_series { …, style }`, `pva_create_channel { …, style }`;
   - a new scene: `pva_create_scene { …, style }` (the scene's style wins over the film's);
   - something that exists: `pva_apply_style { channel, series?, style }`.
   A scene or a series that should look like its film or channel *but* with a
   change: `pva_apply_style { …, fromParent: true }`, then change it.
3. Say what you did: which style, where its copy is, the format it set.

## Making things in a style

Before writing anything that decides the look — the film's bible, a scene's
direction, a shot's plan or prompt, a series' art direction — call
`pva_style` on the unit you are working on. It returns the brief written for
that unit, every value filled in, and the parameters, the skills it asks you
to load (load them) and where its shots usually come from (`shotSource`).

- **Carry the brief, do not paraphrase it away.** The bible's *Look* section
  is the brief plus what the film adds; a shot's plan holds to it; a prompt
  carries its palette and its "Never" list.
- **Code-made styles** (`shotSource: graphics`) are built in code — Remotion,
  shaders, three.js, canvas — rendered as a take under the shot's `assets/`,
  with music as code (`strudel-music`). Every frame a pure function of the
  frame number.
- Reading a unit's style pins it (`source/pins/style.json`). From then on a
  change to the style makes that unit's stages that read it — and everything
  made from them — stale.

## Changing a style

`pva_set_style { channel, series?, param, set: { <id>: <value> } }` — one
parameter file at a time, by entry id: a colour as `#rrggbb`, a number in its
range, one of a menu's options. `brief` replaces STYLE.md (its placeholders
must still name values). Everything is checked before it is written.

A change **invalidates in chain**: every unit that read the style is renewed,
the stages that read it (a film's `bible`, a scene's `direction`, a shot's
`plan` and `media`, an episode's art direction) and all their downstream are
stale, and renders above them are blocked until redone. Tell the person how
much that is before you change a style many units read, and only change it
when they asked.

A person can do the same in the browser studio: the level's overview has a
Style panel with colour pickers and controls for every value.

## Keeping a style

When a person likes what a level's style became — "save this look as 'Tide
riso'" — `pva_save_style { channel, series?, id, title }` keeps it as a
template in the library's `_styles/` (or, with `scope: project`, in the
channel's or film's `styles/`, travelling with it). From then on anyone can
name it in a request, and you make it the same way.

A template of the person's own is written by hand the same way: a folder with
`style.json`, `STYLE.md` and `params/`. `pva_styles` shows any problem it has —
a placeholder that names nothing, a parameter file missing — and a template
with a problem cannot be applied.
