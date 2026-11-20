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
errors. `optionalNodes` names nodes left out when their value is absent;
`bypassNodes` names nodes passed through unless their flag is true.

`fillWorkflow`, `placeholdersOf`, `nodeClassesOf`, `readTemplateFile`.
