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
   - **Draw it to be rigged.** Arms held away from the body with ground
     showing between each arm and the torso, legs apart with ground showing
     between them, nothing worn across two limbs. A model is one skin: where
     a sleeve rests on a coat they are joined, and no rig separates them —
     raise the arm and the coat comes with it, lift the leg and the hem
     does. A long coat, a cape, a skirt to the ground are the hard cases;
     decide here whether the character needs them. The same figure drawn
     both ways and rigged by the same engine: in a long coat with its arms
     at its sides, raising the arms tore 800 edges of the surface; in a
     short jacket and an A-pose, three.
   - **Ask for a tall picture.** A standing figure on a square canvas loses
     its cap and its boots: `outputWidth: 1024, outputHeight: 1536`.
2. **A model** from that picture: `pva_generate_model { channel, series,
   episode, modelId, imagePath, texture }`. It is paid per model and goes
   through the episode's budget, so approve the picture first. It answers
   in a minute or two with what the model holds — triangles, materials,
   textures, its size — and a preview render: look at the preview and open
   the model from every side before going on.
   - **Say how heavy.** Left to itself the model comes back with more than a
     million triangles and forty megabytes: fine for a still, useless for a
     rig. For a figure that will be rigged or animated ask for
     `quad: true, faceLimit: 20000`: the same figure at a fiftieth of the
     weight, as an FBX with its textures inside.
   - **Place it.** It is one unit tall with its origin at its middle, and it
     faces +x where glTF puts the front at +z: lift it by half its height,
     turn it a quarter turn, and scale it to the scene, in the release or in
     every scene that uses it — decide once, and say which in the form's note.
   - `alignToImage` only straightens it by a degree or two; it does not turn
     it to the front.
   Building a creature from primitives by code gives a blocky body and a
   wrong face; image-to-3D gives the look in a minute and no skeleton. A
   model with no skeleton is already a form (`model-3d`): release it as one
   if the character only has to be placed, turned and lit.
3. **A skeleton and weights**: `pva_rig_model { channel, series, episode,
   rigId, modelPath, engine, skeleton, faces }`. Paid per rig, on the
   episode's budget.
   - **Choose the engine by the body.** `hyper3d` rigs a human, a quadruped,
     a bird, a dragon, a kaiju, or — `skeleton: "custom"` with
     `skeletonDescription` — a body you describe in words; it takes a GLB or
     an FBX, and a picture of the character (`imagePath`) helps it choose.
     `meshy` rigs humanoids with clear limbs only, from a GLB, on a skeleton
     animation tools already know (`mixamo`, `blender_rigify_basic_human`,
     …), and adds a walk and a run to every rig.
   - **What each gives back**, on two figures of 17,000 vertices, each
     through both: `hyper3d` answers in twenty seconds with 52 joints,
     fingers among them, up to ten bones a vertex, and leaves the model
     where it was (its origin at its middle). `meshy` answers in fifty with
     24 joints, four bones a vertex, the feet on y 0, an FBX beside the GLB,
     a walk and a run. Every one of those rigs passed the exam.
   - **Textures come through.** A textured model was rigged by both: the
     three texture files came back byte for byte, and the material with
     them. Rig the model you mean to show.
   - **A call can stall.** One rig did not come back in fifteen minutes and
     the same request, sent again, took thirty seconds. The ledger keeps the
     price of a call whose end it did not see; the error names the request,
     which may still finish.
   - **Leave Hyper3D's skinning at `core`**, which is what the tool asks for.
     The service's own default, `shell`, tore the surface ten times as often
     in the same poses on both figures: a seam under the chin when the head
     turned, the coat's hem carried off by the leg as a slab. With `core`,
     Hyper3D and Meshy were as clean as each other on the figure drawn for
     a rig; on the one in a long coat Hyper3D was far the cleaner, and
     Meshy pulled the coat up with the arms like wings.
   - **Send it facing +z.** Say which way the model faces with `faces`; a
     GLB is turned before it is sent. A model from `pva_generate_model`
     faces +x. Send the light model, not the million-triangle one.
   - **Read the exam.** The tool examines what comes back before it answers:
     vertices no bone moves, bones outside the body, a body that stands on
     nothing, a left with no right, clips that move nothing. A rig that
     fails is kept on disk and must not be released. It also says where the
     body stands (on y 0, or with its origin elsewhere) and whether vertices
     follow more than four bones: Blender reads them all, a renderer that
     reads four drops the rest.
   - **Pose it and look**: `pva_rig_sheet { channel, series, episode,
     rigPath }`, local and free. The exam reads the rest pose: it can say a
     rig is broken, never that it is good, and a rig that is right at rest
     and wrong the moment it moves is the usual failure. The sheet puts a
     two-legged body in seven poses — arms up, arms down, reach, step, wide,
     head turn, bow — each from the front, three-quarter and the side, and
     plays the clips that came with the rig over six moments. For any other
     body it swings each of the largest limbs; give `poses` of your own to
     see more, as turns of named bones about the body's axes (`front`, `up`,
     `side`), never about a bone's own: two rigs' bones point different
     ways, and the same numbers would give two different poses.
   - **Read the sheet, then the numbers.** For each pose the tool says how
     much of the surface was strained and how many edges were torn, and
     marks the poses that went further than a sound rig does (ten hand-made
     two-legged rigs stay under 1% strained and tear almost nothing). The
     numbers say where to look and let two attempts be compared pose for
     pose; they do not see a hand passing through a hat, or a face that no
     longer looks like the character. Look at the shoulders, the hips, the
     neck and whatever the character wears.
   - **Automatic rigging is good and not reliable.** Make more than one
     attempt — the other engine, another skeleton — and keep one by what the
     sheet shows, not by which came first. When every attempt fails in the
     same place, the fault is in the model or the picture: go back a step.
   - A rig is a `rig-3d` form. The clips that came with it are its first
     `can.actions`; a form lists only what it has a clip or a pose for.
4. **Motion.** A rig moves as far as its clips go. Each clip is a file
   beside the rig, `<rig>.clip.<name>.glb`: the rig's own body with one
   motion in it. In rising order of cost:
   - **A stock clip, asked for with the rig.** `pva_stock_clips { category,
     search }` lists what Hyper3D has, free: a hundred and more for a human
     body (walks, runs, jumps, gestures, sports, reactions) and clips for
     dogs, birds, fish, hoofed animals, lizards, rodents and turtles, each
     with how long it lasts and whether it can be repeated. Name up to ten
     by id in `clips` on `pva_rig_model` (engine `hyper3d`): they arrive
     with the rig, filed under their names, at no price beyond the rig's.
     `meshy` adds a walk and a run to every rig and nothing by name.
   - **A clip carried from another skeleton**: `pva_retarget_clip { rigPath,
     sourcePath, name }`, local and free. The source is any `.glb` or `.fbx`
     of the episode that holds a skeleton and a motion: a clip one service
     made for another rig, a motion from a library. Bones are paired by the
     part they play, read from their names and from which side of the body
     they are on, and each turn is copied in the world from the rest pose —
     never joint by joint — so the two skeletons may name, point and size
     their bones differently and rest in different poses. Say `sourceFaces`
     when the source faces another way, `inPlace` for a walk the scene will
     move itself, `map` for bones the names did not pair.
   - **A motion from a sentence**: `pva_generate_motion { rigPath, name,
     prompt, seconds }`, $0.08 a motion on the episode's budget. A person's
     motion only. Say who does what, in order, in one English sentence:
     "A person waves hello with the right hand, then bows." What comes back
     is kept in `assets/motion/` and carried to the rig. It may not be all
     that was asked: of "waves, then bows" the wave came, and in the six
     moments of the sheet no bow could be seen. Ask again with another
     `seed`, or ask for one thing a clip.
   - **Play every clip before it is used**: `pva_rig_sheet` shows six moments
     of each from two sides. Feet that slide, a hand through the body, a
     limb bent the wrong way are seen there and are not measured. A motion
     made for a person's proportions puts the hand of a character with a
     large head inside its face.
   - Only two-legged bodies are carried by name. The fingers and the face
     are not carried at all.
   - For anything stranger — a creature, a monster, a thing with wings — and
     no stock clip that fits, **film it instead of animating it**: render
     the model from a known camera on a plain ground, have a video model
     move *that picture*, and copy the video onto the skeleton frame by
     frame. This is not a tool of the studio; do it with what the machine
     has, and keep every intermediate file.

   What makes that last one work, learned the hard way:
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

A form lists a clip as an action only when the clip has been played and
looked at. Record the release with `madeWith` saying exactly what made the
rig and each clip: every clip has a provenance beside it.

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
