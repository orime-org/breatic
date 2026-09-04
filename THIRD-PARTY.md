# Third-Party Notices

Breatic itself is distributed under the Breatic Source-Available License 1.0
(see [LICENSE](./LICENSE)). This file lists third-party components we ship, the
licence each one carries, and where to obtain its source.

A component is listed here when we distribute it — in a published container
image, or inside a front-end bundle served to a browser. Components used only
to build or test Breatic are listed separately at the end, because copyleft
obligations attach to distribution.

## Programs in our container images

The images published to `ghcr.io/<owner>/breatic` and
`ghcr.io/<owner>/breatic-web` are built from [Dockerfile](./Dockerfile) on top of
`node:22-slim` (Debian bookworm) and carry the following program.

### FFmpeg

| | |
|---|---|
| Version | `5.1.9-0+deb12u1` |
| Origin | Debian bookworm, installed with `apt-get install ffmpeg` ([Dockerfile](./Dockerfile), runtime stage) |
| Licence | **GPL-2.0-or-later** |
| Source | `https://sources.debian.org/src/ffmpeg/5.1.9-0+deb12u1/`, or from any Debian mirror via `apt-get source ffmpeg` on bookworm |

FFmpeg's own code is LGPL-2.1-or-later, but Debian builds it with
`--enable-gpl`, `--enable-libx264` and `--enable-libx265`, and those components
are GPL. The resulting binary is therefore GPL-2.0-or-later. It is built without
`--enable-nonfree`, so it remains redistributable.

Breatic invokes the `ffmpeg` executable as a separate process and does not link
against its libraries. The program and Breatic are separate works that happen to
travel in the same image.

Anyone who received one of our images may obtain the complete corresponding
source for this FFmpeg build from the Debian source above. Debian keeps every
published version, including superseded ones, at `sources.debian.org`.

## Packages reachable from the front-end bundle

### BlockNote

| | |
|---|---|
| Version | `0.54.0` |
| Packages | `@blocknote/core`, `@blocknote/react` |
| Reached through | Declared by `packages/web`; the editor a Document Space runs in |
| Licence | **MPL-2.0** |
| Source | https://github.com/TypeCellOS/BlockNote |

MPL-2.0's copyleft is per file: the condition attaches to the files the licence
covers and to modifications of those files, and a larger work that merely
includes them is licensed on its own terms. These files reach the bundle as
published, so the obligation this leaves is the one this entry discharges —
saying what is in there, under which licence, and where the source is.

Upstream also publishes a second half under the `@blocknote/xl-` prefix, offered
as `GPL-3.0 OR PROPRIETARY`. Its GPL-3.0 half would place every bundle it
reaches under GPL-3.0. The `no-gpl-blocknote-addons` check in `repo-lint` reads
both our manifests and the lockfile for that prefix, so one arriving through a
dependency of something else is reported as well.

### DOMPurify

| | |
|---|---|
| Version | `3.4.13` |
| Reached through | `@excalidraw/excalidraw` → `@excalidraw/mermaid-to-excalidraw` → `mermaid` |
| Offered under | MPL-2.0 **or** Apache-2.0, at the recipient's option |
| **Our election** | **Apache-2.0** |
| Source | https://github.com/cure53/DOMPurify |

The package is dual-licensed and we take it under Apache-2.0. Recording the
election here fixes it: nothing in Breatic is subject to MPL-2.0 on account of
this package.

## Build and development tools

These never reach a published artefact. They are recorded so that the licence
picture stays complete when the dependency tree changes.

| Package | Version | Licence | Role | Source |
|---|---|---|---|---|
| `lightningcss` | `1.32.0` | MPL-2.0 | CSS compiler behind `@tailwindcss/node` and `vite`. It compiles our CSS; its own code is not part of the output | https://github.com/parcel-bundler/lightningcss |
| `lightningcss-<platform>` | `1.32.0` | MPL-2.0 | Platform binaries for the above | same |
| `axe-core` | `4.13.0` | MPL-2.0 | Accessibility assertions, a `devDependency` of `packages/web` | https://github.com/dequelabs/axe-core |

## Keeping this file current

Add an entry whenever a dependency that reaches a published artefact carries a
licence other than MIT, Apache-2.0, BSD or ISC — those four are permissive
enough that listing every one of them would bury the entries that matter. The
project's rule on which licences may be taken at all, and which need a decision
first, lives in the collaboration spec.

The dependency tree is walked by reading `license` from every
`node_modules/.pnpm/*/node_modules/*/package.json`. The FFmpeg entry is read
from the image itself:

```
docker run --rm node:22-slim bash -c \
  'apt-get update -qq && apt-get install -y --no-install-recommends ffmpeg >/dev/null && ffmpeg -version'
```

Last verified: 2026-09-01.
