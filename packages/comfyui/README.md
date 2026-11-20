# @av/comfyui

A ComfyUI server's HTTP API, and workflows kept as API-format templates with
named placeholders. It knows no model: what a graph does is the template's
business, and which server runs it is the caller's.

```ts
import { createComfyUiClient, fillWorkflow, readTemplateFile } from "@av/comfyui";

const client = createComfyUiClient({ baseUrl: "http://127.0.0.1:8188" }); // the caller's address; none is built in
const template = readTemplateFile(new URL("./my-graph.json", import.meta.url));
const promptId = await client.queuePrompt(fillWorkflow(template, { prompt: "a lighthouse at dusk", seed: 7 }));
const { outputs } = await client.waitForPrompt(promptId);
```

## The client

`queuePrompt` (`POST /prompt`), `waitForPrompt` (polls `GET /history/<id>`),
`uploadInput` (`POST /upload/image`, which takes audio and video too),
`download` (`GET /view`), `nodeInfo` (`GET /object_info/<class>`),
`systemStats`, `dequeue`. A refused graph reports the server's own words,
node by node; a graph that raised reports the node and its exception. Errors
are `ComfyUiError` with a `code` to branch on: `not-configured`,
`unreachable`, `bad-request`, `missing-node`, `failed`, `timeout`, `aborted`,
`no-output`, `server`.

A server that listens only on its own loopback is reached through a tunnel
the caller opens; the client just sees a URL.

## Templates

An API-format graph (ComfyUI: *Export (API)*) in which a string value that is
exactly `"{{name}}"` is replaced by the value of that name, keeping the
value's type. A missing value and a value no placeholder asks for are both
errors. `optionalNodes` names nodes left out when their value is absent (and
drops the inputs of other nodes that read them, which must be optional
inputs); `bypassNodes` names nodes passed through unless their flag is true.

`fillWorkflow`, `placeholdersOf`, `nodeClassesOf`, `readTemplateFile`.

## Declared workflows

A template that says what it takes and what it makes, so that a caller who
has never seen the graph can run it:

```json
{
  "description": "Text to image with Z-Image Turbo.",
  "kind": "image",
  "inputs": {
    "prompt": { "type": "text" },
    "width":  { "type": "integer", "default": 1024, "min": 256, "max": 2048 },
    "seed":   { "type": "seed" },
    "start":  { "type": "image", "optional": true }
  },
  "outputs": { "9": "image" },
  "requires": {
    "models": [{ "node": "16", "input": "unet_name", "folder": "diffusion_models" }]
  },
  "prompt": { "…": "the API-format graph, with {{prompt}}, {{width}}, {{seed}}, {{start}}, {{outputPrefix}}" },
  "optionalNodes": { "start": "2" }
}
```

- **kind**: `image`, `image-edit`, `video`, `speech`, `music`, `audio`, `other`.
- **inputs**, one per placeholder: `text`, `string`, `integer`, `number`,
  `boolean`, `choice` (with `options`), `seed` (picked at random when absent,
  and returned), or a file: `image`, `audio`, `video`, uploaded to the
  server's input folder under its content's hash, its name filled in.
- **outputs**: node id → `image`, `video` or `audio`. Every file the node
  saved is downloaded, whatever key the server lists it under.
- **requires**: `models` names a loader node's input; the file is the value
  it holds (or its placeholder's default) and the probe checks the loader
  lists it. `nodes` adds classes beyond the graph's own, `packs` says which
  custom node packs provide them. Nothing is downloaded.
- **verifiedOn**: when and where it last ran on a real server; absent, never.
- `{{outputPrefix}}` is the runner's: each run saves under a folder of its own.

`checkWorkflow` lists what is wrong (the UI format instead of the API one, a
placeholder not declared, an input nothing reads, an output that is not in
the graph). `listWorkflows(folders)` reads the built-in workflows and then
each folder's, a later one hiding an earlier one of the same name and saying
so.

`probeWorkflow(client, workflow)` reads `/object_info/<class>` for every class
the graph needs and the choices of every model input: whether the server can
run it, before anything is queued. `runWorkflow({ client, workflow, values })`
checks the values, probes, uploads, queues, waits and downloads; the result
has the graph as queued, every value filled in, the seeds, the uploads by
hash, each output's bytes, the server's version and devices, and how long the
server says it ran (`executionSeconds`, from its own timestamps).

## Built-in workflows

Core ComfyUI nodes only. **None has been run against a real server from this
repository yet** (none has `verifiedOn`): check the node and model names
against yours before relying on them.

| Workflow | Kind | Models it requires |
|---|---|---|
| `z-image-turbo` | text to image | `z_image_turbo_bf16.safetensors`, `qwen_3_4b.safetensors`, `ae.safetensors` |
| `flux2-klein-edit` | image edit | `flux-2-klein-4b.safetensors`, `qwen_3_4b.safetensors`, `flux2-vae.safetensors` |
| `wan22-ti2v-5b` | text or first frame to video | `wan2.2_ti2v_5B_fp16.safetensors`, `umt5_xxl_fp8_e4m3fn_scaled.safetensors`, `wan2.2_vae.safetensors` |
| `ace-step-music` | music from tags and lyrics | `ace_step_v1_3.5b.safetensors` |

## Adding a workflow

1. Build and run the graph in ComfyUI.
2. Export it in API format (*Workflow → Export (API)*; older versions need
   *Dev mode* on in the settings).
3. Replace each value a caller should set with `"{{name}}"` — the whole
   string, so a number stays a number — and every output node's
   `filename_prefix` with `"{{outputPrefix}}"`.
4. Wrap the graph: `description`, `kind`, `inputs`, `outputs`, `requires`
   (above), the graph under `prompt`.
5. `checkWorkflow` (or the studio's listing tool) says what does not fit.
