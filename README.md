# Sergio

**Make episode twenty as good as episode one.**

A local, open-source production system for video made with AI agents. Your
agent — Claude Code or Pi — writes, generates and edits. The studio keeps what
the agent forgets: every attempt, what each paid call cost, the licence of
each borrowed asset, and each decision you approved. So a series stays a
series, and a correction stays small: a fix at second 47 leaves everything
else alone.

## Made with it

| A film of this kind | Length |
|---|---|
| A software explainer written from one pinned commit of the repository it explains | 3 min 47 s |
| An ambient room: a looping master, extended to its length on the machine | 1 hour |
| A visual essay re-edited from the start around a narration that did not change | 3 min 4 s |
| An illustrated film cut to an original score | 4 min 14 s |
| A Blender scene built by script and kept editable | 15 s |
| A vertical lesson: one episode of a series with a fixed format | 54 s |

[Watch them on the product site](https://phoebus-84.github.io/video-studio-site/examples), each with its receipt:
what it was made from, what it cost where a cost was recorded, and whose work
is in it. They are named there and not here: the application knows no library
(ADR-0044).

## What it does

- **It repeats.** A series' format is a pinned release: its compiler, its
  validator, its kits. An episode is a data file checked against it. Episode
  twenty goes through the same code as episode one.
- **It corrects.** Every attempt is kept and what depends on what is known.
  Change one thing and only what depends on it is made again; the render
  reuses the seconds that did not change, a film re-renders the shots that
  did, and two renders can be compared to show nothing else moved.
- **It accounts.** A budget per episode, reserved before a paid call is made.
  A licence and its evidence for every borrowed asset. An approval only the
  operator can give, bound to what was approved.

It makes two kinds of work. A **channel** keeps making episodes of a series
to a pinned format. A **film** is one self-contained piece, short or feature
length, produced at three levels — the film, its scenes, their shots — from
real footage, stock, generated and programmed material, each level with its
own cut, edited by the agent or by a person on a timeline and rendered with
FFmpeg in the pieces that changed.

## What it is not

- **Not the fastest way to one video.** If you need one clip now, a hosted
  generator gets you there sooner. This pays off the second time you make the
  same kind of video.
- **Not a model catalogue.** It works with a few providers, chosen on
  purpose, and with what runs on your own machine.
- **Not unattended.** The agent works; you decide; the decision is recorded.
  [`docs/harness-review.md`](docs/harness-review.md) says where enforcement
  stops.
- **Not measured yet.** Whether it does better than a capable model working
  alone has not been tested. The test is written down first:
  [`bench/retake`](bench/retake/README.md), a specification with no results.

## Install

```bash
bun install                       # one install for every module
npm run compose -- --profile=full # wire the pieces you want
npm run doctor                    # check this machine can run them
```

This installs and wires the workspace, not every external tool or provider.
See [`docs/install.md`](docs/install.md) for profiles, requirements and
credentials.

Your first render needs no account and no key:

```bash
npm run demo:render               # six seconds of titles, rendered and audited
```

It runs once the workspace and FFmpeg are ready, and downloads Remotion's
headless browser the first time.

Then [run the agent](docs/running.md):

```bash
ln -sfn /path/to/your/library library    # once — where episodes live
pi -e studio/agent/extensions/index.ts   # Pi
claude                                   # or Claude Code, from the repository root
```

The browser UI is optional; the agent's pipeline tools still need a running
gateway for stage tracking, approval requests and budget status. See the
[running guide](docs/running.md).

You do not have to take all of it. `npm run compose -- --list` shows the
profiles; `--profile=voice` gives you just the voice tool, `--profile=render`
just the rendering packages.

## How it is built

An agent — Pi, or Claude Code through the studio's MCP server — is the
executive producer; a deterministic runtime keeps pipeline state; dedicated
packages generate media; Remotion renders the episode's edit timeline and
FFmpeg masters and checks it; a gateway connects the agent to a browser studio.

### The shape of this repository

The repository is split along one line, and that line is enforced by
`npm run check:boundaries`:

```
packages/     reusable outside this project — they know nothing about episodes,
              pipelines, or the studio. Use them in any project.

studio/       the product. Depends on packages/. All studio-specific
              integration lives here, never inside a package.

skills/       shared/ is useful in any agent workflow; studio/ holds the
              production-stage skills.
```

A voice tool should be a voice tool. The fact that this studio uses it to
narrate episodes is the studio's business, not the tool's.

| Package | What it is on its own |
|---|---|
| `packages/remotion-composer` | Renders a layered, kit-based edit timeline with Remotion, then normalises loudness |
| `packages/render-worker` | Renders that timeline on other machines over SSH, or shares it among several |
| `packages/voice` | Speech synthesis, voice cloning, forced alignment and transcription on MLX |
| `packages/fal-media` | Tracked image, video and 3D model generation against fal.ai, with provenance and cost |
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

## Documentation

The product website, recipes and selected films live in the website's own Git
project. Its build does not depend on this workspace;
it imports an explicit snapshot of the technical reference when requested.

The application documentation remains under [`docs/`](docs/index.md), with its
own lightweight VitePress reference site:

```bash
npm run docs:dev     # http://localhost:5173
npm run docs:build   # also fails on any dead internal link
```

- [Install and composition](docs/install.md)
- [Running the agent](docs/running.md)
- [Channel Git and media storage](docs/workspace.md#git-and-storage) — version text and restore media by hash
- [Architecture](docs/architecture.md)
- [Domain language](docs/context.md)
- [Workspace layout](docs/workspace.md)
- [Pipelines](docs/pipelines.md)
- [Contributing](docs/contributing.md)
- [Blender setup and workflow](packages/blender/README.md)
- [DaVinci Resolve editorial handoff](docs/resolve-handoff.md) — optional integration through the actively maintained [davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp)
- [Harness review and improvement priorities](docs/harness-review.md)
- [Changelog](CHANGELOG.md), and [what a release number promises](docs/contributing.md#releases)
- [Retake](bench/retake/README.md) — the specification of a benchmark for what happens after the first take
- [Per-component reference](docs/index.md#packages)
- [Decision records](docs/adr/)

## Everyday commands

```bash
npm test                  # every module's tests
npm run typecheck         # every module's typecheck
npm run check             # paths + boundaries + typecheck + tests
npm run compose -- --list # available profiles
npm run doctor            # toolchain, credentials, capability readiness
npm run resolve:plan -- --help # offline Resolve handoff preflight; live edits use upstream MCP
```

## Licence

The reusable tools in `packages/` are Apache-2.0; the studio and everything
else is AGPL-3.0-only. [LICENSING.md](LICENSING.md) says why, and what neither
covers (Remotion, vendored code, your library).
