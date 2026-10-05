# Versioned releases

A release is one selected commit already merged into `main`, identified by an annotated Git tag such as `v0.2.0`. It can include many PRs. Creating a release does not deploy it.

## Maintainer workflow

1. Merge a PR that sets the five product image tags in `docker-compose.yml` to the new version (for example `v0.2.0`). For a release that goes through candidates, merge it before the first `-rc` tag.
2. Merge the intended PRs and confirm CI is green. Inspect the selected commit and migrations.
3. Fetch `origin/main`, choose its full commit SHA, then create and push a new tag:

   ```bash
   git fetch origin main
   git tag -a v0.2.0 <full-commit-sha> -m 'Release 0.2.0'
   git push origin refs/tags/v0.2.0
   ```

   These values are examples, not a claim that this release exists. Use a new version each time. Supported tags are `vMAJOR.MINOR.PATCH` and `vMAJOR.MINOR.PATCH-rc.N`, without leading zeroes. The selected commit must be an ancestor of `origin/main`. For a stable tag, `docker-compose.yml` at that commit must name the same version for all five product images; CI stops before reserving the release otherwise. Candidate tags skip this check.
4. Tag CI runs all checks and builds the backend and web images for `linux/amd64`. It verifies both embedded versions and the media image licence files before publishing.
5. CI reserves a draft GitHub Release, pushes the tested images to GHCR, attaches `release.json`, then publishes the Release. No manual Docker upload is needed. PRs and branch pushes build images for checks without publishing; `main`, `latest` and minor-version aliases are no longer updated.
6. Download the completed Release's manifest. Test these exact image digests with your own environment configuration. Schedule production separately, using the same digests. Frontend and backend rollout order must follow compatibility and migration requirements; the tag does not prove cloud configuration is valid.

The images are `ghcr.io/orime-org/breatic:v0.2.0` and `ghcr.io/orime-org/breatic-web:v0.2.0`. Deploy by the `@sha256:…` references in the manifest for production. Record and retain manifests, image digests and deployed frontend assets; registry cleanup must exclude deployed and rollback versions.

## Where the version lives

| Location | Meaning |
|---|---|
| Git tag `v0.2.0` | Human-selected release identity and source commit |
| Backend `/app/build-info.json` | Build-injected `releaseVersion` and full `revision`, shared by Server, Worker, Collab and migrations |
| Frontend `/app-version.json` | `releaseVersion`, full `revision`, and `version` used by the existing update checker |
| OCI image labels | `org.opencontainers.image.version` and `.revision` |
| `docker-compose.yml` | The five product image tags, equal to the stable release this source belongs to |
| GitHub Release `release.json` | Schema version, tag, release version, revision, repository, platform and immutable backend/web image references |

`version` in the frontend JSON remains the full commit SHA for backward compatibility with the existing update checker. The readable version is `releaseVersion`. nginx serves this JSON with `Cache-Control: no-store`.

Version metadata is part of each artifact, not an operator-editable runtime `.env`. `package.json` is not changed per release; workspace package versions describe internal packages, not deployed release identity. Ordinary untagged developer builds are labelled `0.0.0-dev`; a development revision may be `unknown`.

Backend verification without database connections:

```bash
docker run --rm --entrypoint cat <backend-image-at-digest> /app/build-info.json
```

Build arguments are `RELEASE_VERSION` and `VCS_REF` for the backend; `VITE_RELEASE_VERSION` and `VITE_APP_VERSION` for the web. CI supplies them from the tag and commit. Frontend URL and Google configuration remain separate public build settings.

## Interrupted or repeated publication

A tag identifies one release forever. The draft reserves the version before the first registry push. A rerun cannot replace an existing draft or published Release. If publication fails after reservation, preserve the failed draft for investigation and use a new version tag; do not deploy partial images. Do not delete/recreate or move release tags to retry. Failed checks before reservation can be rerun, except a `docker-compose.yml` mismatch, which fails the same way on every rerun of that tag. Before tagging a new version, merge the PR that sets `docker-compose.yml` to it.

Protect `v*` tags from update/deletion in repository settings and enable GitHub immutable releases where available. Only trusted maintainers should be able to create release tags. Workflow guards prevent ordinary accidental reruns; administrators must also preserve registry digests and release assets.

For local Docker use, obtain the source of a release as described in [LOCAL.md](LOCAL.md); from `v0.0.2` on, its `docker-compose.yml` runs that release's images. Building Ingest checks its Dockerfile but does not publish its Worker; deploy Ingest from the matching source separately.
