# Licensing

This repository carries two licences, split along the same line as the code
([repository layout](docs/repository-layout.md)).

| Part | Licence | Text |
|---|---|---|
| `packages/*` — the reusable tools | Apache License 2.0 | `LICENSE` in each package |
| Everything else — `studio/`, `skills/`, `tools/`, `docs/` | GNU Affero General Public License v3.0 only | [`LICENSE`](LICENSE) |

Each workspace's `package.json` (and `packages/voice/pyproject.toml`) states
its licence in the `license` field; that field is the authority for the
workspace it sits in.

## Why two

A package knows nothing about the studio, so it should be usable anywhere:
in a closed product, in another agent's toolbox, on its own. Apache-2.0 allows
that and grants a patent licence.

The studio is the product. AGPL-3.0 keeps it open when someone runs a modified
copy as a service: they owe their users the source of what they run.

## What is not covered

- **Third-party code keeps its own terms.** A tree with a `VENDORED.md`
  (for example `skills/shared/remotion-best-practices`) is a copy of someone
  else's work under their licence.
- **Remotion is not free software.** `packages/remotion-composer` and the
  studio's renderer depend on [Remotion](https://www.remotion.dev/docs/license),
  which is free for individuals and for companies of up to three people and
  needs a company licence beyond that. Using the studio does not grant you a
  Remotion licence; check their terms for your case.
- **A library is not part of the application.** Channels, series, episodes,
  films and their media live in a library outside this repository (ADR-0021,
  ADR-0044, ADR-0045) and carry whatever licences their owners give them.
  Nothing here licenses a video made with the studio.
- **Models and services** reached through the packages (speech, image and
  video models, archives) have their own terms.

## Contributing

A contribution is accepted under the licence of the part it changes: Apache-2.0
for `packages/`, AGPL-3.0-only for the rest.

Copyright © 2026 the Video Studio authors.
