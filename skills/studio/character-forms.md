---
name: character-forms
version: "0.1.0"
description: Give a character a form — choose the medium that suits the job (rigged 3D, cut-out puppet, sprites, code-drawn vector, reference pictures, a photograph, a dot, a sound, a voice alone), make it with the right tools, say what it can do, check it, and record it as a release that productions pin
inputs:
  - name: owner
    type: string
    description: The channel or the film the character belongs to
  - name: id
    type: string
    description: The character's id
outputs:
  - characters/<id>/forms/<form>/<release>/:
      kind: directory
      description: The form's files as released, recorded in character.yaml with the hash of their tree
capabilities:
  - llm
---

# Character forms

A *form* is one way a character appears. A character can have several — a
puppet for the sketches, a pixel figure for the explainers, a voice alone for
the radio cut — and a production says which it wears (`pva_cast`).

The character exists first (`character-development`). Read its three
documents before you make anything: a form that contradicts `character.md` is
wrong however good it looks.

## Choose the medium for the job, not the other way round

| Medium | It is | Good for | Costs |
|---|---|---|---|
| `voice` | a voice and nothing to look at | narrators, guides, anyone heard and not seen | nothing to draw |
| `sound` | a sound that is the character | a presence, a running gag, an object that reacts | a second of audio |
| `graphic` | a shape and how it behaves: a dot, a cursor, a line | abstract explainers, a pointer with moods | code |
| `vector` | a drawing made by code, with poses and palettes | a recurring host that must be the same in every frame | a component to write once |
| `sprites` | drawn poses on a sheet, played as actions | comic gestures, pixel figures, reactions over footage | one sheet per set of gestures |
| `puppet-2d` | a flat figure cut into parts and rigged | sketches with dialogue, repeatable acting | a rig to build once |
| `rig-3d` | a 3D model with a skeleton | movement in space, camera freedom, many actions | a model, a rig and motion |
| `model-3d` | a 3D model with no skeleton | objects, props that matter, statues | a model |
| `images` | reference pictures for a generator | generated shots that must keep a face | drifts: check every shot |
| `photo` | a photograph, still or made to speak | a real presenter | needs `likeness` |
| `other` | anything else | say what in `mediumNote` | |

Take the **cheapest medium that can do what the scripts ask**. A voice and a
dot have carried whole series. A rig is worth its cost only when the
character must move in ways you cannot list in advance.

Two questions decide it:

1. *Must it be exactly the same in every episode?* Then it is drawn or built
   once (`vector`, `sprites`, `puppet-2d`, `rig-3d`), not generated per shot.
   A generated character is a new guess each time.
2. *Can you list what it does?* If yes — twelve gestures, five expressions —
   draw those (`sprites`, `vector`). If no, it needs a rig.

## Say what it can do

`pva_update_character { owner, id, form: { id, medium, title, description,
can: { actions, expressions, mouths, views } } }`

`can` is the contract between writing and animation. List **only what is in
the files**, by the names a script will use:

- `actions`: `idle`, `walk`, `wave`, `type`, `facepalm`;
- `expressions`: `neutral`, `puzzled`, `proud`;
- `mouths`: the mouth shapes it has for speech; leave it out if it has none;
- `views`: `front`, `three-quarter`, `side`.

A script that asks for an action not listed is caught before anything is
animated (`pva_cast { asks }`). So do not list what you hope to add: add it,
release it, then list it.

## Make it — by medium

**A voice.** `pva_voices` for the registry; `pva_synthesize_speech` to hear
the profile on the character's own lines. Set it on the character with
`voiceProfile`. A clone of a real voice is a likeness: the character needs
`likeness`.

**A sound.** `pva_synthesize_nonverbal_audio` or `pva_synthesize_sound` for a
motif; keep it short and in one key, so it sits under speech. Release the
audio file; `voice.motif` can name it.

**A graphic.** It is a kit's props or a few lines of composition code: what
the dot is, and how it shows each state (`blink`, `hesitate`, `dart`). Release
the file that defines it, and list the states as `actions`.

**A vector figure.** A component drawn by code: variants, palettes,
expressions and poses as inputs, nothing random inside. Rigged SVG can be
rendered with `pva_render_vector_animation`. Release the component with a
picture of every pose and expression side by side (a *sheet*), and look at it.

**Sprites.**
1. Generate or draw one **pose sheet** on a plain ground: every pose of every
   gesture, same size, feet on the same line (`pva_generate_image`, with the
   character's identity in the prompt and a first approved pose as
   reference).
2. Cut it into poses on a common canvas, feet aligned.
3. Write the actions: for each, which poses, in which order, held for how
   many frames, and whether it loops. That manifest is the entry file.
4. Render every action once and watch it. A pose that changes the
   character's proportions is dropped, not kept "for variety".

**A cut-out puppet.** Part sheets (head, torso, limbs, mouths) generated or
drawn, then cut, pivoted and weighted in Blender by script
(`pva_blender_create_scene`, the `blender-scene` skill). The master file is
never saved over: an episode appends the rig and animates a copy.

**A 3D rig.** Four steps, each checked before the next is paid for:
1. **A picture.** One approved image of the character, plain ground, the view
   the model will be built from. This is where identity is decided.
2. **A model** from that picture: `pva_generate_model { channel, series,
   episode, modelId, imagePath, texture }`. It is paid per model and goes
   through the episode's budget, so approve the picture first. It answers
   with what the model holds — triangles, materials, textures — and a
   preview render: look at the preview and open the model from every side
   before going on. `quad: true` gives a mesh that is easier to rig.
   Building a creature from primitives by code gives a blocky body and a
   wrong face; image-to-3D gives the look in a minute and no skeleton. A
   model with no skeleton is already a form (`model-3d`): release it as one
   if the character only has to be placed, turned and lit.
3. **A skeleton and weights.** Automatic rigging is good and not reliable:
   make several attempts and keep one by *checking it against the model* —
   every limb that touches the ground has a bone, left matches right, no bone
   sticks out of the body. A rig chosen by eye in one pose deforms in the
   next.
4. **Motion.** In rising order of cost:
   - a clip from a library, retargeted to the rig by a bone map — rotations
     copied in world space from the rest pose, never joint by joint between
     rigs of different proportions;
   - for a human body, motion generated from text and constraints;
   - for anything stranger — a creature, a monster, a thing with wings —
     **film it instead of animating it**: render the model from a known
     camera on a plain ground, have a video model move *that picture*, and
     copy the video onto the skeleton frame by frame. Keyframes written by
     code look artificial; a generated video of the model moves like the
     animal.

   What makes the last one work, learned the hard way:
   - **Know the camera.** The picture given to the video model is your own
     render, so every pixel's place on the body is known.
   - **One view cannot see depth.** A side view hides which leg is nearer; an
     arm reaching to camera is a guess. Put **two cameras in one picture**
     (front and side): generated separately the two videos never match, and
     with two a joint can only be in one place.
   - **Check the video before you use it.** Do both halves show the same
     move? Does the frame rate in the file match the motion in it? It is
     quicker to generate another than to repair one.
   - **Give the reader of joints an exam.** Make up a motion yourself, render
     it with the same cameras, and compare what the reader finds with what
     you know, bone by bone — before paying for a single generated video, and
     again after every change to the method.
   - **A match of outlines is not a match.** "84% of frames pass" hid mostly
     broken frames. Look at the frames: model under video, one above the
     other.

Automatic rigging, motion from text and motion from video are not tools of
the studio yet. Do those steps with what the machine has, keep every
intermediate file, and record the result as a release with `madeWith` saying
exactly what made it. The model's provenance keeps the provider's task id
(`providerTaskId`): its rigging service takes that in place of the file.

A model is made in an episode, where the budget is, and lands in
`assets/models/`. To make it the character's, copy the model, its preview and
its provenance into `characters/<id>/forms/<form>/<release>/` and record that
folder (below).

**Reference pictures.** A front, a three-quarter and an expression sheet,
approved by a person, on a plain ground. Every generated shot is then checked
against them; the form's `can` lists the views the pictures cover and nothing
else.

**A photograph.** Needs `likeness` on the character. A photo made to speak is
a picture of a real person saying words: the permission must cover that use.

## Check it before you release it

- **Look at it**, all of it: a sheet with every pose, expression and view; a
  clip of every action. Compare with `character.md`, feature by feature.
- **Same character?** Proportions, palette and the recognising feature are
  the same in every pose. If a pose drifts, drop it.
- **Does it do what `can` says?** Play each listed action and expression by
  name. One that is missing is taken off the list.
- **Does it sit in a frame?** Feet on the ground, readable at the size the
  series shows it, mouth visible when it speaks.

## Release it

Put the files in `characters/<id>/forms/<form>/<release>/` — the entry file,
what it needs, the sheet and the proofs — then:

`pva_update_character { owner, id, release: { form, release: "v1", entry,
madeWith: [{ tool, provider?, model?, note? }], licence: { id,
redistributable, attribution? } } }`

- The folder is recorded with the hash of every file. **It is never edited
  again.** A fix is `v2`.
- `madeWith` says what made it: the model, the program, the hand. It is how
  the next release is made the same way.
- `licence` matters for anything you did not make: a free model's licence
  decides whether the channel may publish it. `redistributable: false` keeps
  it out of what is shared.
- A folder a channel already kept elsewhere in the character's own can be
  recorded where it is, with `path`.

`pva_characters { owner, id }` then reads every released file back and says
whether each is still what was recorded.

A production that cast the character keeps the release it pinned. To move it
to the new one, cast the role again (`pva_cast`).
