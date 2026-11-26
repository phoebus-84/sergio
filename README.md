# Sergio

**Make episode twenty as good as episode one.**

Sergio is a local, open-source studio for making video with AI agents. Your
agent, Claude Code or Pi, writes, generates and edits. Sergio keeps what the
agent forgets: every attempt, what each paid call cost, the licence of each
borrowed asset, and each decision you approved.

<p>
<a href="https://phoebus-84.github.io/video-studio-site/examples"><img height="150" alt="An illustrated film cut to an original score" src="https://phoebus-84.github.io/video-studio-site/showcase/lontano.jpg"></a>
<a href="https://phoebus-84.github.io/video-studio-site/examples"><img height="150" alt="An ambient room: a looping master, one hour long" src="https://phoebus-84.github.io/video-studio-site/showcase/ambient-kowloon.jpg"></a>
<a href="https://phoebus-84.github.io/video-studio-site/examples"><img height="150" alt="A visual essay re-edited around a narration that did not change" src="https://phoebus-84.github.io/video-studio-site/showcase/nothing-is-only-one-thing.jpg"></a>
<a href="https://phoebus-84.github.io/video-studio-site/examples"><img height="150" alt="A Blender scene built by script and kept editable" src="https://phoebus-84.github.io/video-studio-site/showcase/underwater.jpg"></a>
<a href="https://phoebus-84.github.io/video-studio-site/examples"><img height="150" alt="A software explainer written from one pinned commit of the repository it explains" src="https://phoebus-84.github.io/video-studio-site/showcase/jaromail.jpg"></a>
<a href="https://phoebus-84.github.io/video-studio-site/examples"><img height="150" alt="A vertical lesson: one episode of a series with a fixed format" src="https://phoebus-84.github.io/video-studio-site/showcase/sonnet.jpg"></a>
</p>

Six films made with Sergio, from a one-hour ambient room to a 54-second
vertical lesson. **[Watch them](https://phoebus-84.github.io/video-studio-site/examples)**,
each with its receipt: what it was made from, what it cost where a cost was
recorded, and whose work is in it.

**[Website](https://phoebus-84.github.io/video-studio-site/)** ·
**[Install](https://phoebus-84.github.io/video-studio-site/install)** ·
**[Recipes](https://phoebus-84.github.io/video-studio-site/recipes/)** ·
**[Documentation](docs/index.md)** ·
**[Changelog](CHANGELOG.md)**

## Why it exists

One good video is easy now. The tenth one in the same series, with the same
voice, the same look and the same rules, is not: the agent forgets, the costs
drift, and a fix in one place breaks three others. Sergio is built for the
tenth one.

- **It repeats.** A series' format is a pinned release: its compiler, its
  validator, its kits. An episode is a data file checked against it. Episode
  twenty goes through the same code as episode one.
- **It corrects.** Every attempt is kept, and Sergio knows what depends on
  what. Change one thing and only what depends on it is made again: a fix at
  second 47 leaves everything else alone, and two renders can be compared to
  show nothing else moved.
- **It accounts.** A budget per episode, reserved before a paid call is made.
  A licence and its evidence for every borrowed asset. An approval only you
  can give, bound to what you approved.

It makes two kinds of work. A **channel** keeps making episodes of a series to
a pinned format. A **film** is one self-contained piece, short or feature
length, made at three levels (the film, its scenes, their shots) from real
footage, stock, generated and programmed material. Each level has its own cut,
edited by the agent or by a person on a timeline, and rendered with FFmpeg in
the pieces that changed.

## What it is not

- **Not the fastest way to one video.** If you need one clip now, a hosted
  generator gets you there sooner. Sergio pays off the second time you make
  the same kind of video.
- **Not a model catalogue.** It works with a few providers, chosen on purpose,
  and with what runs on your own machine.
- **Not unattended.** The agent works; you decide; the decision is recorded.
  [`docs/harness-review.md`](docs/harness-review.md) says where enforcement
  stops.
- **Not measured yet.** Whether it does better than a capable model working
  alone has not been tested. The test is written down first:
  [`bench/retake`](bench/retake/README.md), a specification with no results.

## Try it

```bash
bun install                       # one install for every module
npm run compose -- --profile=full # wire the pieces you want
npm run doctor                    # check this machine can run them
npm run demo:render               # six seconds of titles, rendered and audited
```

The first render needs no account and no key. It runs once the workspace and
FFmpeg are ready, and downloads Remotion's headless browser the first time.
This installs and wires the workspace, not every external tool or provider:
[`docs/install.md`](docs/install.md) covers profiles, requirements and
credentials.

Then [run the agent](docs/running.md) from the repository root:

```bash
ln -sfn /path/to/your/library library    # once: where episodes live
pi -e studio/agent/extensions/index.ts   # Pi
claude                                   # or Claude Code
```

The browser studio is optional, but the agent's pipeline tools need a running
gateway for stage tracking, approval requests and budget status. The
[running guide](docs/running.md) explains both.

You do not have to take all of it. `npm run compose -- --list` shows the
profiles: `--profile=voice` gives you just the voice tool, `--profile=render`
just the rendering packages.

## How it works

The agent (Pi, or Claude Code through Sergio's MCP server) is the executive
producer. A deterministic runtime keeps the pipeline's state. Dedicated
packages generate media. Remotion renders the episode's timeline, FFmpeg
masters and checks it, and a gateway connects the agent to a browser studio.

The repository is split along one line, enforced by
`npm run check:boundaries`:

```
packages/   reusable anywhere: they know nothing about episodes, pipelines or the studio
studio/     the product, built on packages/; all studio-specific integration lives here
skills/     shared/ for any agent workflow; studio/ for the production stages
```

A voice tool should be a voice tool. That this studio uses it to narrate
episodes is the studio's business, not the tool's.

<details>
<summary><strong>The packages</strong>: what each one is on its own</summary>

| Package | What it is on its own |
|---|---|
| `packages/remotion-composer` | Renders a layered, kit-based edit timeline with Remotion, then normalises loudness |
| `packages/render-worker` | Renders that timeline on other machines over SSH, or shares it among several |
| `packages/voice` | Speech synthesis, voice cloning, forced alignment and transcription on MLX |
| `packages/fal-media` | Tracked image, video and 3D model generation, and rigging, against fal.ai, with provenance and cost |
| `packages/codex-image` | Image generation and editing through an OpenAI subscription or the Images API |
| `packages/elevenlabs` | ElevenLabs client: forced alignment, with rate and retry rules |
| `packages/archive-media` | Free archive and stock media with verifiable licences |
| `packages/audio-edit` | Audio cut on words, layered, ducked and mastered from a recipe |
| `packages/strudel` | Music written as Strudel code, checked and rendered offline: parts, loops, stems, and what was made in numbers |
| `packages/graphics` | Deterministic SVG/PNG code frames, diagrams, callouts, titles |
| `packages/infographics` | Frame-accurate animated infographics via Remotion |
| `packages/terminal-recorder` | A terminal session recorded to video from a VHS tape |
| `packages/blender` | Editable 3D scenes, Geometry Nodes, Eevee/Cycles animation and Poly Haven assets |
| `packages/video-composer` | Typed timeline → FFmpeg filter graph; probes and QA; multitrack mixes; the cut renderer (effects, transitions, mix, loudness) |

</details>

<details>
<summary><strong>The studio</strong>: the modules of the product</summary>

| Studio module | Role |
|---|---|
| `studio/contracts` | Canonical schemas, vocabulary, bindings |
| `studio/series` | Series compilers: episode spec and narration → edit timeline |
| `studio/episode` | An episode on disk, produced: timeline built or compiled, checked, rendered |
| `studio/film` | A film on disk, produced: scenes and shots, footage, a cut at each level assembled, edited and rendered |
| `studio/cast` | Characters on disk: who they are, the forms they take, and a production's cast pinned to what it wears |
| `studio/runtime` | Snapshots, leases, staleness, journal, policy |
| `studio/pipelines` | Built-in pipeline manifests |
| `studio/agent` | The executive-producer tools: a Pi extension, served to Claude Code over MCP |
| `studio/adapters` | Stage adapters: the code that performs a stage, matched by contract |
| `studio/gateway` | Agent sessions (Pi RPC or the Claude Agent SDK) and event streaming |
| `studio/web` | Browser studio |

</details>

## Documentation

The [website](https://phoebus-84.github.io/video-studio-site/) has the guides,
the recipes and the films. It lives in its own repository and does not build
from this one. The films are named there and not here: the application knows
no library (ADR-0044).

The application's own documentation is under [`docs/`](docs/index.md), with a
lightweight VitePress reference site (`npm run docs:dev`, and
`npm run docs:build`, which also fails on any dead internal link).

- [Install and composition](docs/install.md) and [running the agent](docs/running.md)
- [Architecture](docs/architecture.md), [domain language](docs/context.md) and [pipelines](docs/pipelines.md)
- [Workspace layout](docs/workspace.md), and [channel Git and media storage](docs/workspace.md#git-and-storage): text versioned, media restored by hash
- [Contributing](docs/contributing.md), and [what a release number promises](docs/contributing.md#releases)
- [Blender setup and workflow](packages/blender/README.md)
- [DaVinci Resolve editorial handoff](docs/resolve-handoff.md), through the actively maintained [davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp)
- [Harness review and improvement priorities](docs/harness-review.md)
- [Retake](bench/retake/README.md): the specification of a benchmark for what happens after the first take
- [Per-component reference](docs/index.md#packages) and [decision records](docs/adr/)

<details>
<summary><strong>Everyday commands</strong></summary>

```bash
npm test                  # every module's tests
npm run typecheck         # every module's typecheck
npm run check             # paths + boundaries + typecheck + tests
npm run compose -- --list # available profiles
npm run doctor            # toolchain, credentials, capability readiness
npm run resolve:plan -- --help # offline Resolve handoff preflight; live edits use upstream MCP
```

</details>

## Licence

The reusable tools in `packages/` are Apache-2.0; the studio and everything
else is AGPL-3.0-only. [LICENSING.md](LICENSING.md) says why, and what neither
covers (Remotion, vendored code, your library).
