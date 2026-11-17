---
name: character-development
version: "0.1.0"
description: Define a character for a channel, a series or a film — who it is before how it appears — as a record with its identity, backstory and way of playing, its voice, and its place in a cast; a character can be a person, an animal, an object, a dot, a sound
inputs:
  - name: owner
    type: string
    description: The channel or the film the character belongs to
  - name: series
    type: string
    description: A series of the channel, when the character is that series' own
outputs:
  - characters/<id>/character.yaml:
      kind: file
      description: The character's record — who it is, its voice, its forms
  - characters/<id>/character.md:
      kind: file
      description: Identity, with backstory.md and performance.md beside it
  - cast.yaml:
      kind: file
      description: In a series or a film, the roles and who plays them
capabilities:
  - llm
---

# Character development

A character is **who**, before **how it appears**. It is a record
(`characters/<id>/character.yaml`) and three documents; it has no body until
it is given a *form* (the `character-forms` skill), and it can have several.
The same character may hold different roles in different productions.

Anything can be a character: a sergeant, a fox, a lamp, a cursor that
hesitates, a low hum that means someone is thinking. What makes it one is not
a face. It is that it **wants something, behaves in a way you can predict,
and is the same next week**.

## Before you make one

1. `pva_characters { owner }` — who is there already. Do not make a second
   character for a part an existing one can play: give it a role
   (`pva_cast`).
2. Decide who owns it:
   - **the channel**, when more than one series may use it (the usual case);
   - **a series**, when it only makes sense there;
   - **a film**, for a film's own characters.
   A series finds its own characters first, then its channel's. Another
   owner's character is cast as `owner/id`, and stays where it lives.
3. If it is drawn from a **real person** — a face, a voice, a name — you need
   `likeness`: whose, and what permits it (who agreed, when, to what use).
   Without that, stop and ask the person you work for. Never invent a
   permission.

## The three documents

Write them in full. A model that makes episode twenty has only these to know
the character by; a thin document makes a different character every time.

**`character.md` — identity: what never changes.**
- What it is, in one paragraph a stranger could cast from.
- What it looks and sounds like, as far as that is fixed: proportions,
  palette, the one feature it is recognised by. For a character that is not a
  figure: what it is on screen (a dot, 12 px, top right), or in the sound.
- What must **not** be changed to fit a shot. Say it as rules: "never
  slimmed", "never without the cap", "never speaks".
- Its name, and how others call it.

**`backstory.md` — where it comes from, and what it wants.**
- What it wants in every scene, in a sentence. A character with no want
  only stands there.
- What it is afraid of, or cannot do. Comedy and drama both come from here.
- Its relations: who it respects, who it misreads, who it needs. Put the
  ones that recur in the record too (`relations`).
- Only the past that changes how it behaves now. Not a biography.

**`performance.md` — how it plays.**
- How it moves: tempo, weight, the gesture it repeats, what it does when it
  listens.
- How it speaks: register, sentence length, the words it uses and the ones
  it never would. For a voice: pace, where it breathes.
- Its engine: *why a scene with it works*. ("He follows a wrong idea to its
  end with complete conviction; the audience sees what he does not.")
- What it never does. ("Never explains the joke after the punchline.")
- For something that is not a person, the same questions: how a dot shows it
  is unsure; what the hum does when the answer comes.

Keep each to what a writer or an animator would act on. Cut anything that
would be true of any character.

## Making it

`pva_create_character { owner, series?, id, name, summary, nature, identity,
backstory, performance, voiceProfile?, likeness? }`

- `id` is a slug and is for ever: scripts and casts name the character by it.
- `nature` is free words: `a person`, `a fox`, `a doubt`, `a sound`.
- `voiceProfile` is a key of the owner's voice registry (`pva_voices`). If
  the voice is a clone of a real person's, that is a likeness too.
- It writes the manifest and the three documents and overwrites nothing. A
  document you did not give is left as a prompt to fill: fill it.

Then read it back with `pva_characters { owner, id }`. It lists what is still
wrong or missing.

## Changing it

`pva_update_character { owner, id, … }`: `summary`, `nature`, `status`,
`voiceProfile`, `likeness`, `relations`, `tags`; `null` removes a field. The
documents are files: edit them.

- `status: ready` when a production may cast it: the documents are written
  and it has at least what its first production needs.
- **Identity is additive.** A new costume, a new form, a new release: yes. A
  different face, a different want: that is another character, with another
  id. Productions already made keep what they pinned.

## Casting

A character is in a production when it has a role there:

`pva_cast { channel, series, role, character, standing? }` or
`pva_cast { film, role, character, … }`

- `role` is the part as that production's scripts name it. It need not be
  the character's id: the sergeant can be `keeper` in a film.
- `standing`: `lead`, `regular`, `guest`, `cameo`, `extra`.
- `voice` gives the part another voice than the character's own.
- Casting pins the release of the form the character has then. A later
  release does not change productions already cast; cast the role again to
  take it.

`pva_cast { channel, series }` shows the cast: who is ready, who is on paper
only, what each form can do. **Read it before writing a script**, and write
only what the cast can do — or check a draft with `asks`:

`pva_cast { channel, series, asks: [{ role, actions, expressions, views }] }`

## What a character is not

- Not an asset of one episode. If it will not come back, it is a prop or a
  walk-on: describe it in the script.
- Not its model, its rig or its picture. Those are forms, and they are
  replaced; the character is not.
- Not a list of adjectives. "Curious, warm, funny" casts nobody. A want, a
  limit and a way of behaving do.
