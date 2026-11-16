---
name: footage-ingest
version: "0.1.0"
description: Bring real footage, location sound, stock and music into a film, look at every clip, and log it — what it shows, whether it is usable, the scene and shot it serves — so a cut can be made from it
inputs:
  - name: film
    type: string
    description: The film's slug
  - name: files
    type: array
    description: Full paths of the files on this machine — a card, a folder of takes, a recorder's WAVs, bought clips
outputs:
  - footage/catalog.json:
      kind: file
      description: The footage log — one entry per clip with its measurements, tags, notes, licence and the scene and shot it is for
  - footage/:
      kind: directory
      description: media/ (the clips, named by content), proxies/ (what a browser plays), sheets/ (a contact sheet per clip)
capabilities:
  - llm
---

# Bring Footage In

A film made from real material starts here. Nothing downstream can use a
file that was not brought in: a cut names its sources inside the film, and
a file on a memory card is not in the film.

## Bring it in

`pva_ingest_footage { film, files, origin }` — up to fifty paths a call.
For each file the studio copies it into `footage/media/` under a name made
from its content, measures it, and writes a log entry with:

- its streams, frame size, frame rate, length, codec;
- a **contact sheet** under `footage/sheets/` — frames across the clip,
  each stamped with its time;
- the instants its **picture cuts** (a long take is one segment; a reel of
  takes is several);
- a **proxy** under `footage/proxies/` that plays in a browser, whatever
  the camera wrote;
- its **loudness**.

The same file brought in twice is found, not copied again.

| `origin` | for |
| --- | --- |
| `camera` | picture shot for the film (the default) |
| `recording` | sound recorded for it: dialogue, wild tracks, room tone, foley |
| `stock` | bought or archive material — give `licence` |
| `generated` | something a model made elsewhere and the film adopts |
| `other` | anything else |

Options that matter:

- `link: true` leaves camera originals where they are and links to them.
  Use it for material too large to keep twice, and only when the person
  said the disk stays attached: a linked clip is gone when its disk is.
- `licence` — for anything that is not the film's own. Who made it and on
  what terms. A stock clip without it is a clip the film cannot ship.
- `scene`, `shot`, `tags`, `notes` — when the whole batch is for one thing
  ("card A is all of scene 12"), say it once here.

Music goes in the same way (`origin: stock` or `other`, with its licence)
and is then a source like any other: `{ "project": "footage/media/<file>" }`.
A score written for the film can instead be put under `music/` directly.

## Look at every clip

A log nobody looked at is a list of filenames. For each new clip, **open
its contact sheet** — it is an image; read it — and write down what is
actually there:

`pva_footage { film, annotate: { id, tags, notes, scene, shot } }`

- **`notes`** — what the clip shows, in a sentence, then what is wrong or
  special about it, with times from the sheet's stamps: *"Mara crosses the
  car park, left to right, handheld. Focus hunts 0:04–0:06. Best pass is
  the second, from 0:11."*
- **`tags`** — words someone will search by: the character, the place, the
  size (`wide`, `close`), the take's quality (`good`, `ng`, `safety`), what
  it is (`room-tone`, `wild-track`, `plate`).
- **`scene` / `shot`** — the unit it was shot for, when you can tell from
  the picture, the slate, the filename or what the person said.

For sound, the loudness and length say whether it is usable (a recording
peaking at 0 dBTP is clipped; a room tone needs ten clean seconds), and
`pva_analyze_audio` measures further. You cannot hear it: say what you
measured, not how it sounds.

When a clip is several takes in one file, the log's `segments` are where
its picture cuts. Note in `notes` which segment is which take.

To look closer at one clip — more frames, or a part of it —
`pva_inspect_media { film, path: "project:footage/media/<file>", segments: true, columns, rows }`
writes a denser sheet under the film's `artifacts/inspect/`.

## Find it again

`pva_footage { film, query, kind, origin, scene }` — every word of the
query must be in the clip's name, tags, notes, scene or shot. This is how a
shot finds its takes, so the words you logged are the words that will be
searched.

## What to hand back

When the batch is in and logged, say:

- how many clips, how much running time, by origin;
- what is usable and what is not, and why;
- which scenes and shots now have footage, and which shots of the
  breakdown are `source: footage` and still have none;
- anything with no licence, anything linked rather than copied.

## What not to do

- Do not rename, trim, transcode or "clean up" what was brought in. The log
  is the record of what was shot; a cut takes the part it wants with `in`
  and a length, and a grade or a repair is an effect in the cut.
- Do not decide a take is unusable from its filename. Look.
- Do not ingest the same card twice under a different origin to "fix" the
  log: annotate the entries.
