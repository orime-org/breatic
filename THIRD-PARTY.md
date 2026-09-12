# Third-Party Notices

Breatic itself is distributed under the Breatic Source-Available License 1.0
(see [LICENSE](./LICENSE)). This file lists third-party components we ship, the
licence each one carries, and where to obtain its source.

A component is listed here when we distribute it — in a published container
image, or inside a front-end bundle served to a browser. Components used only
to build or test Breatic are listed separately at the end, because copyleft
obligations attach to distribution.

## Programs in our container images

We publish three images, and two of them carry FFmpeg:

| Image | Built from | Base | Carries FFmpeg |
|---|---|---|---|
| `ghcr.io/<owner>/breatic` | [Dockerfile](./Dockerfile) | `node:22-slim` (Debian bookworm) | yes |
| the media container | [packages/ingest/Dockerfile](./packages/ingest/Dockerfile) | `alpine:3.22` | yes |
| `ghcr.io/<owner>/breatic-web` | [Dockerfile.web](./Dockerfile.web) | `nginx:1.27-alpine` | no — it serves the built front-end and nothing else |

Breatic invokes the `ffmpeg` executable as a separate process and does not link
against its libraries. The program and Breatic are separate works that happen to
travel in the same image. The `no-ffmpeg-binding-deps` check in `repo-lint` and
the `breatic/no-ffmpeg-bindings` ESLint rule hold that apart: the first reads
our manifests and the lockfile, the second reads every module specifier, so a
package that would put those libraries in our process is reported wherever it
arrives from.

### FFmpeg in the `breatic` image

| | |
|---|---|
| Version | `7:5.1.9-0+deb12u1` — the epoch is Debian's, and upstream FFmpeg calls this 5.1.9 |
| Origin | Debian bookworm, installed with `apt-get install ffmpeg=7:5.1.9-0+deb12u1` ([Dockerfile](./Dockerfile), runtime stage) |
| Licence | **GPL-2.0-or-later** |
| Source | `apt-get source ffmpeg=7:5.1.9-0+deb12u1` on bookworm with `deb-src` enabled, or the files themselves from `http://deb.debian.org/debian/pool/main/f/ffmpeg/` |

FFmpeg's own code is LGPL-2.1-or-later, but Debian builds it with
`--enable-gpl`, `--enable-libx264` and `--enable-libx265`, and those components
are GPL. The resulting binary is therefore GPL-2.0-or-later. It is built without
`--enable-nonfree`, so it remains redistributable.

Anyone who received this image may obtain the complete corresponding source for
this FFmpeg build from either address above. Both serve whatever bookworm holds
now, so the version is pinned in the Dockerfile: the pin is what keeps them
pointing at the binary the image actually carries. Once bookworm moves past it,
that version stays available at `snapshot.debian.org`, and the pin's build
failure is the signal to update this entry alongside it.

### FFmpeg in the media container

| | |
|---|---|
| Version | `6.1.2-r2` |
| Origin | Alpine 3.22, installed with `apk add ffmpeg=~6.1` ([packages/ingest/Dockerfile](./packages/ingest/Dockerfile)) |
| Licence | **GPL-2.0-or-later AND LGPL-2.1-or-later**, as the Alpine package declares |
| Source | `https://ffmpeg.org/releases/ffmpeg-6.1.2.tar.xz` for the program, and `https://gitlab.alpinelinux.org/alpine/aports/-/tree/19c99e366c9185609249108011f9f621c66f204e/community/ffmpeg` for the recipe Alpine built it with |

This image carries its own copy of the two licence texts and a `SOURCE` file
naming the version and both addresses, at `/usr/share/ffmpeg-source/`. Those
values are read out of the package database while the image is built, so a
rebuild that resolves `=~6.1` to a later release writes the later one rather
than repeating what is written here. The aports commit above names the recipe
exactly; a branch name would move on and stop describing this build.

The image is the whole of `packages/ingest/Dockerfile` plus this repository, so
anyone holding it can rebuild it from source.

## Packages in our container images

The `breatic` image carries the production `node_modules` of `server`, `worker`
and `collab` beside our own code, so every production dependency of those three
is distributed with it. These are the ones whose licence is not one of the four
permissive ones. The media container carries no `node_modules` at all — its
service is bundled into a single file — and the `breatic-web` image carries the
front-end bundle covered by the next section.

### Server-side packages under other licences

| Package | Version | Reached through | Licence | Source |
|---|---|---|---|---|
| `@sesamecare-oss/redlock` | `1.4.0` | `packages/collab` → `@hocuspocus/extension-redis` | Reported as **UNLICENSED**, which is what its `package.json` declares. The published tarball carries a `LICENSE.md`, and that file is the MIT licence. The metadata is wrong about the package, not the other way round | https://github.com/sesamecare/redlock |
| `json-schema` | `0.4.0` | `packages/core` → `@ai-sdk/*` → `@ai-sdk/provider` | AFL-2.1 **or** BSD-3-Clause, at the recipient's option. **Our election: BSD-3-Clause** | https://github.com/kriszyp/json-schema |
| `postgres` | `3.4.9` | Declared by `packages/core`; also the peer `drizzle-orm` resolves | **Unlicense**, a dedication to the public domain, which asks nothing of us | https://github.com/porsager/postgres |

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

Upstream also publishes a second half under the `@blocknote/xl-` prefix, each
package offered as a copyleft licence or a proprietary one at the recipient's
choice: `GPL-3.0 OR PROPRIETARY` for six of them, and `AGPL-3.0 OR PROPRIETARY`
for `xl-ai-server`. Taking any of them under the copyleft option would place
every bundle it reaches under that licence, and the AGPL one reaches further
still — it carries the same terms over a network. The
`no-gpl-blocknote-addons` check in `repo-lint` reads both our manifests and the
lockfile for that prefix, so one arriving through a dependency of something
else is reported as well.

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

### @fontsource/inter

| | |
|---|---|
| Version | `5.3.0` |
| Reached through | Declared by `packages/web`; `packages/web/src/index.tsx` imports five weights |
| Licence | **OFL-1.1** (SIL Open Font License 1.1) |
| Source | https://github.com/rsms/inter |

The font files are served to the browser as published. OFL-1.1 asks that the
copyright notice and licence travel with them, which is what this entry is.
Inter's copyright line declares no Reserved Font Name, so the licence's naming
restriction has nothing to bite on. Its one prohibition — selling the font
files on their own — is not something Breatic does.

### jszip

| | |
|---|---|
| Version | `3.10.1` |
| Reached through | `packages/web` → `mammoth` 1.12.1, which reads `.docx` archives |
| Offered under | MIT **or** GPL-3.0-or-later, at the recipient's option |
| **Our election** | **MIT** |
| Source | https://github.com/Stuk/jszip |

Taking the GPL-3.0-or-later half would carry that licence to every bundle this
package reaches. We take the MIT half, and recording the election here fixes
it.

### Other packages in the bundle

| Package | Version | Reached through | Licence | Source |
|---|---|---|---|---|
| `fractional-indexing` | `3.2.0` | `@excalidraw/excalidraw` | **CC0-1.0**, a dedication to the public domain, which asks nothing of us | https://github.com/rocicorp/fractional-indexing |
| `khroma` | `2.1.0` | `@excalidraw/excalidraw` → `@excalidraw/mermaid-to-excalidraw` → `mermaid` | Reported as **Unknown**, because its `package.json` carries no `license` field at all. The published tarball carries a `license` file, and that file is the MIT licence | https://github.com/fabiospampinato/khroma |
| `pako` | `2.0.3`, `1.0.11` | `@excalidraw/excalidraw` (2.0.3); `mammoth` → `jszip` (1.0.11) | **MIT AND Zlib** — its own code under MIT, the parts ported from zlib under Zlib. Both ask only that the notice travel along | https://github.com/nodeca/pako |
| `robust-predicates` | `3.0.3` | `@excalidraw/excalidraw` → `@excalidraw/mermaid-to-excalidraw` → `mermaid` → `d3` → `d3-delaunay` → `delaunator` | **Unlicense**, a dedication to the public domain | https://github.com/mourner/robust-predicates |

## Build and development tools

These never reach a published artefact, so none of them creates an obligation
on anyone who receives Breatic. The dev-only tree holds 29 packages under a
licence that is not one of the four permissive ones; the three below are
recorded because they are the ones a reader is most likely to stop on. The rest
are not transcribed here — the command in the next section lists them, and what
that list is for is catching a licence the project may not take at all.

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

The npm half of that rule is a check rather than a habit: the
`notice-covers-dependencies` check in `repo-lint` runs `pnpm licenses list
--json --prod`, and reports any package under a licence that is not wholly
permissive unless this file names it above the "Build and development tools"
heading and states the same licence. There are three reads, one per part of
this file.

| Part | How it is read |
|---|---|
| The distributed npm packages | `pnpm licenses list --json --prod` — the same source the check reads |
| The build and development tools | `pnpm licenses list --json` without `--prod`, minus the packages the line above reports. Read it for a licence the project may not take, not to transcribe it — nothing here is distributed |
| The two FFmpeg builds | For the `breatic` image, `dpkg-query -W ffmpeg` inside it. For the media container, `awk '/^P:ffmpeg$/,/^$/' /lib/apk/db/installed` — the same source `packages/ingest/Dockerfile` reads to write the image's own `SOURCE` file |

A package reported under `Unknown` or `UNLICENSED` means its `package.json`
says nothing usable, not that the package is unlicensed. Open the licence file
in its own tarball before writing the entry; two of the entries above exist
because that file said MIT where the metadata said otherwise.

Last verified: 2026-09-12.
