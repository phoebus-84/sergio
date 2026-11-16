---
name: film-development
version: "0.1.0"
description: Develop a film on paper — logline, synopsis and treatment, then the screenplay written to the length the film is meant to run — from an idea, a text or the footage at hand
inputs:
  - name: film
    type: string
    description: The film's slug; its film.yaml, sources/ and footage/ are what there is to start from
outputs:
  - artifacts/treatment.md:
      kind: text/markdown
      description: Logline, synopsis, the story beat by beat, what the film is made of, and the questions still open
  - artifacts/screenplay.md:
      kind: text/markdown
      description: The screenplay — numbered scenes with sluglines, action and dialogue
capabilities:
  - llm
---

# Develop a Film

Two stages of the film's pipeline, both on the film's own unit
(`<film>/_/_`): **development** writes `artifacts/treatment.md`,
**screenplay** writes `artifacts/screenplay.md`. Nothing is drawn, shot or
generated here. What is decided here is what everything after it costs.

## Before writing

Read, in this order:

1. `film.yaml` — the title, the format, and above all
   `runtimeTargetSeconds`: the length the film is meant to run.
2. `sources/` — whatever the person brought: a script, a story, notes, a
   transcript. If they wrote a screenplay, **it is the screenplay**: your
   work is to put it in the form below, not to rewrite it.
3. `footage/` — `pva_footage { film }`. If footage exists, the film is made
   *from* it: a documentary, a film built on real takes. Look at the contact
   sheets (`footage/sheets/`) before proposing anything it cannot show.
4. `bible/`, `references/`, the film's `skills/` — anything already decided.

Then say what kind of film this is, because it decides everything below:

| the film is | the screenplay is |
| --- | --- |
| written fiction | scenes of action and dialogue |
| a documentary or a film from footage | scenes of what the footage shows and what is said over it — narration is dialogue, marked `(V.O.)` |
| an essay or abstract piece | scenes as movements: what is seen, what is heard, how long |

## The treatment

`artifacts/treatment.md`, in prose a person can read in five minutes:

```markdown
# <Title>

**Logline.** One or two sentences: who, what they want, what is in the way.

**Synopsis.** A paragraph or three: the whole story, ending included.

## Beats
1. **<beat>** (≈ 0:40) — what happens and what changes.
2. …

## Made of
What the picture is: footage at hand, generated shots, archive, graphics — and
roughly how much of each. What the sound is: sync, dialogue to record or
synthesise, narration, music, silence.

## Open questions
What you had to assume, as questions the person can answer in a word.
```

The beats' lengths must add up to the target running time. If the material
cannot fill it, or cannot fit in it, say so here — do not pad and do not
quietly cut.

Set `logline` and `synopsis` on the film with `pva_update_unit { film, set }`
once the treatment says them: the board and every later stage read them
from `film.yaml`.

## The screenplay

`artifacts/screenplay.md`. One convention, kept strictly, because the
breakdown reads it mechanically:

```markdown
# <Title>

## 1. INT. HOSPITAL CAR PARK - NIGHT

Action, in the present tense: only what can be seen and heard. One
paragraph per beat of the action.

MARA
(under her breath)
That can't be right.

TOMAS (O.S.)
You're late.

## 2. INT. WARD - CONTINUOUS
…
```

- A scene is a `##` heading: its number, then the slugline —
  `INT.` / `EXT.` / `INT./EXT.`, the place, a dash, the time of day.
- A character's name in capitals on its own line opens a line of dialogue;
  a parenthetical under it is how it is said. `(V.O.)` is narration or a
  voice over the picture; `(O.S.)` is someone present and unseen.
- No camera directions. How a scene is covered is the breakdown's work, and
  a screenplay that says "CLOSE ON" has decided it without looking.

### Length

A page of screenplay runs about a minute; said aloud, dialogue runs about
150 words a minute. Before you finish, estimate each scene's length and
total them:

```markdown
## Running time
| scene | est. |
| --- | --- |
| 1 | 0:35 |
…
| **total** | **9:50** of 10:00 planned |
```

Within a tenth of the target is on length. Outside it, revise the
screenplay — or, when the idea really is a different length, say so and ask
whether to change `runtimeTargetSeconds`.

## What a good one has

- Every scene changes something. A scene that could be cut without anyone
  noticing is not a scene.
- Dialogue that can be said. Read each line aloud in your head: a voice —
  recorded or synthesised — has to perform it.
- Nothing the film cannot make. A crowd of thousands, a recognisable real
  person, a location nobody has footage of: each is a cost or an
  impossibility downstream. When the story needs one, flag it in the
  treatment's open questions rather than writing around it silently.

## Completing the stage

Complete the stage with its output path. In a pipeline that asks, both
stages wait for a person: ask with `pva_request_approval`, and expect the
answer to be notes on the text. Revise the file — it is versioned — rather
than writing a second one.
