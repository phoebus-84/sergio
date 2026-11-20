---
name: comfyui-workflows
version: "0.1.0"
description: Make pictures, edits, clips and music with the ComfyUI workflows on the operator's own GPU server — when to use them rather than the paid generators or Codex images, how to run one into an episode or a film unit with its receipt, where what it made goes next, and how an operator adds a workflow of their own
inputs:
  - name: need
    type: string
    description: What is to be made (a still, an edit of one, a clip, a cue), for which unit, and whether the operator asked for ComfyUI
outputs:
  - assets/:
      kind: directory
      description: What a run made — assets/images/, assets/video/comfyui/, assets/audio/ — each file with <file>.comfyui.json beside it
  - music/:
      kind: directory
      description: Generated music, with its receipt
capabilities:
  - llm
---

# ComfyUI workflows

The operator runs a ComfyUI server on their own GPU. Any graph they have
built there can be run through the studio, with the studio's provenance,
when it is written down as a **workflow**: an API-format template with
`{{placeholders}}`, its inputs, its outputs and the nodes and models it
needs (ADR-0055). Speech is not here: it goes through
`pva_synthesize_speech` with `provider: "comfyui-qwen"` (the `narration`
skill), which also designs voices from a description.

## When ComfyUI, and when not

| | ComfyUI | fal (`pva_generate_image`, Wan/MiniMax video) | Codex images |
|---|---|---|---|
| Money | $0 — the operator's GPU | per image or clip, on the spend ledger | the operator's ChatGPT plan |
| Time | minutes for a clip; one graph at a time on a shared GPU | seconds to a minute | seconds |
| Models | whatever the server has: Z-Image, FLUX.2 [klein], Wan 2.2, ACE-Step, the operator's own graphs | the profiles the studio knows | gpt-image |
| Ready | only when the server answers and has the workflow's nodes and models | with a key | with a plan |

- **Use it when the operator asks for it**, when the channel's, series' or
  film's own skill says so, or when a workflow does what nothing else here
  does (generated music, an edit with a local model, a graph of theirs).
- **Offer it** when it would do as well for $0: say so, and let the
  operator choose. A series' `image.provider` still decides what
  `pva_generate_image` uses; a ComfyUI run is a separate, explicit call.
- **Never as a fallback.** A paid call that fails is not retried on
  ComfyUI, and a ComfyUI run that fails is not retried on a paid service,
  without the operator's word.
- **Never on a server that cannot run it**: the probe says so before
  anything is sent. Do not install nodes or download models: tell the
  operator what is missing and where it goes (`models/<folder>`).

## Running one

1. `pva_capability_status` — does the server answer, which workflows can it
   run. `pva_comfyui_workflows { channel }` lists them all, with the
   channel's or film's own; `workflow: "<name>"` shows one in full: every
   input with its type, default and range, the outputs, the models.
2. `pva_comfyui_run` on the unit: `channel`/`series`/`episode` as every
   tool takes them (a film: the film, the scene or `_`, the shot or `_`),
   `workflow`, `name`, and `inputs`. A file input is the workspace-relative
   path of a file of that unit; it is uploaded under its content's hash, so
   no local name reaches the server.
3. **Look at what it made** before using it. A workflow that says *never
   run on a real server yet* may be wrong in a node's name or a model's
   file; the first run is its test.
4. **A retake** is the same call with another `seed` (the receipt has the
   one used; give it back to make the same take again) or a changed input,
   under a new `name`. Nothing is ever written over.

Each output lands by kind — images in `assets/images/`, clips in
`assets/video/comfyui/`, music in `music/`, speech in
`artifacts/narration/`, other audio in `assets/audio/` (or `folder`) — as
`<name>.<ext>`, and `<name>-2.<ext>`… when a node saved several. Beside each,
`<file>.comfyui.json`: the workflow and the graph by hash, every value, the
input files by hash, the seeds, the models named, the server's version,
`runtimeVerified: false` (ComfyUI names models, it does not attest them),
`$0`, and the GPU time, which also goes to the unit's journal.

## Where it goes next

| Made | Next |
|---|---|
| An episode's picture | name the run after the scene: `assets/images/<sceneId>.png` is where the spec looks, as for `pva_generate_image` |
| A shot's still or clip | the shot's cut: `pva_edit_cut`, a clip with `source: { path }` (`film-editing`) |
| An edit of a picture | `flux2-klein-edit` with `image` the picture, `prompt` what to change and what to keep |
| A clip from a still | `wan22-ti2v-5b` with `image` the first frame; without it, from the prompt alone |
| Music | `music/<cue>.<ext>`: the cut's music track, levels and ducking as any cue (`film-sound`); `pva_music` lists it |
| Speech made by a workflow of the operator's | `pva_register_take`, `pva_align_take`, `pva_verify_take` (`narration`) |

## Adding a workflow of the operator's

The operator's workflows live in the library's
`.render/comfyui/workflows/`, for every channel and film on that machine;
a channel's or film's own in `<channel>/comfyui/workflows/`, and travel with
its repository. A later one hides a built-in or library one of the same
name, and the listing says so.

1. Build and run the graph in ComfyUI until it makes what is wanted.
2. Export it **in API format**: *Workflow → Export (API)* (older versions:
   enable *Dev mode* in the settings first). The UI's own format, with
   `nodes` and `links`, is refused.
3. In the export, replace each value a caller should set with
   `"{{name}}"` — the whole string, in quotes, even for a number: the value
   keeps its type when filled — and each output node's `filename_prefix`
   with `"{{outputPrefix}}"`.
4. Wrap it, and save it as `<name>.json` (lowercase, digits, `-`):

```json
{
  "description": "Lip-sync a portrait to a line with MuseTalk.",
  "kind": "video",
  "inputs": {
    "portrait": { "type": "image", "description": "A front-facing face" },
    "line": { "type": "audio", "description": "The take to say" },
    "seed": { "type": "seed" }
  },
  "outputs": { "12": "video" },
  "requires": {
    "packs": ["the custom node pack that provides the MuseTalk nodes"],
    "models": [{ "node": "3", "input": "model_name", "folder": "musetalk" }]
  },
  "prompt": { "…": "the exported graph, with {{portrait}}, {{line}}, {{seed}}, {{outputPrefix}}" }
}
```

- `kind`: `image`, `image-edit`, `video`, `speech`, `music`, `audio`, `other`.
- Input types: `text`, `string`, `integer`, `number` (with `min`, `max`),
  `boolean`, `choice` (with `options`), `seed`, and the files `image`,
  `audio`, `video`. `default` makes an input optional; `optional: true` with
  `optionalNodes: { "<input>": "<node id>" }` leaves a node out when the
  input is not given (a first frame), and drops what read it.
- `outputs`: the id of every node that saves a result, and whether it is an
  `image`, a `video` or `audio`. Video saved by the core `SaveVideo` and by
  VideoHelperSuite's combine node both work.
- `requires.models`: each loader node and the input that names its file;
  `folder` is where the file goes under `models/`. The probe checks the
  server lists it. Nothing downloads it.
- `verifiedOn`: once it has run well on the server, when and where
  (`"ComfyUI 0.3.75, RTX 4090, 2026-11-20"`).

5. `pva_comfyui_workflows { workflow: "<name>" }` says what does not fit —
   a placeholder not declared, an input nothing reads, an output not in the
   graph — and whether the server can run it. Then one run, looked at.

A server started with `--disable-all-custom-nodes` runs the built-in
workflows (core nodes only) and none that needs a pack: the listing names
the missing nodes.

## Never

- Never present a workflow's output as checked when it was not looked at.
- Never download a model or install a custom node on the operator's server.
- Never write over a generated file, or edit one in place: run again.
- Never put the server's address in a file of the library or the code: it
  is `AVG_COMFYUI_URL` or the library's `.render/comfyui.json`.
